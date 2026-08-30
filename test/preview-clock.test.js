"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const clock = require("../src/renderer/preview-clock");

test("frames within tolerance are painted", () => {
  assert.equal(clock.frameDecision({ frameSourceTime: 1.0, clockSourceTime: 1.0 }).action, "accept");
  assert.equal(clock.frameDecision({ frameSourceTime: 1.05, clockSourceTime: 1.0 }).action, "accept");
  assert.equal(clock.frameDecision({ frameSourceTime: 0.95, clockSourceTime: 1.0 }).action, "accept");
});

test("frames materially behind the clock are dropped", () => {
  assert.equal(clock.frameDecision({ frameSourceTime: 1.0, clockSourceTime: 2.0 }).action, "drop");
});

test("a slightly early frame is held so the clock can catch up", () => {
  const decision = clock.frameDecision({ frameSourceTime: 1.2, clockSourceTime: 1.0 });
  assert.equal(decision.action, "hold");
});

// The freeze: -readrate runs the decoder ahead of the clock and every dropped
// frame advances the reported source time further, so skew grows without bound.
// Holding can never resolve that, and the canvas stops updating forever.
test("a persistently diverged pipe resyncs instead of holding forever", () => {
  const decision = clock.frameDecision({ frameSourceTime: 4.0, clockSourceTime: 1.0 });
  assert.equal(decision.action, "resync", "unbounded skew must relaunch the pipe, not stall");
  assert.equal(decision.skew, 3);
});

test("a paused clock paints an early frame rather than stranding it", () => {
  assert.equal(clock.frameDecision({ frameSourceTime: 9, clockSourceTime: 1, paused: true }).action, "accept");
});

test("non-numeric timing falls back to painting the frame", () => {
  assert.equal(clock.frameDecision({ frameSourceTime: undefined, clockSourceTime: 1 }).action, "accept");
});

test("held frames release once the clock reaches them", () => {
  assert.equal(clock.shouldReleaseHeldFrame({ frameSourceTime: 1.2, clockSourceTime: 1.0 }), false);
  assert.equal(clock.shouldReleaseHeldFrame({ frameSourceTime: 1.2, clockSourceTime: 1.15 }), true);
  assert.equal(clock.shouldReleaseHeldFrame({ frameSourceTime: 1.2, clockSourceTime: 0, paused: true }), true);
});

// The freeze that survived the readrate fix: ffmpeg needs ~0.5s to emit its
// first frame while the hidden video starts its clock immediately, so the pipe
// trails the clock by a constant amount. Every frame is then late by that same
// amount, every frame is dropped, and the canvas never paints.
test("a stable startup lag is measured and compensated instead of dropping forever", () => {
  const lag = clock.createLagTracker();
  assert.equal(lag.offset, 0, "nothing is compensated before there is evidence");
  let decision = clock.frameDecision({ frameSourceTime: 1.0, clockSourceTime: 1.5, lagOffset: lag.offset });
  assert.equal(decision.action, "drop");
  for (let i = 0; i < clock.LAG_SAMPLES_REQUIRED; i += 1) {
    lag.observe(clock.frameDecision({
      frameSourceTime: 1.0 + i / 60,
      clockSourceTime: 1.5 + i / 60,
      lagOffset: lag.offset
    }).rawSkew);
  }
  assert.ok(Math.abs(lag.offset - -0.5) < 0.01, `expected ~-0.5s offset, got ${lag.offset}`);
  decision = clock.frameDecision({ frameSourceTime: 2.0, clockSourceTime: 2.5, lagOffset: lag.offset });
  assert.equal(decision.action, "accept", "a frame at the measured baseline must paint");
});

test("a decoder genuinely falling further behind keeps dropping", () => {
  const lag = clock.createLagTracker();
  // Skew worsening by 0.1s per frame exceeds the stability band, so the run
  // restarts every sample and no baseline is ever established.
  for (let i = 0; i < clock.LAG_SAMPLES_REQUIRED * 2; i += 1) lag.observe(-0.5 - i * 0.1);
  assert.equal(lag.offset, 0, "drift must not be absorbed as a fixed offset");
});

test("an in-window frame clears the accumulating evidence", () => {
  const lag = clock.createLagTracker();
  for (let i = 0; i < clock.LAG_SAMPLES_REQUIRED - 1; i += 1) lag.observe(-0.5);
  lag.noteHealthy();
  lag.observe(-0.5);
  assert.equal(lag.offset, 0, "a recovered pipe must restart the measurement");
});

test("a measured offset is discarded on relaunch or seek", () => {
  const lag = clock.createLagTracker();
  for (let i = 0; i < clock.LAG_SAMPLES_REQUIRED; i += 1) lag.observe(-0.5);
  assert.ok(lag.offset < 0);
  lag.reset();
  assert.equal(lag.offset, 0);
});

test("held frames respect the measured offset so they cannot strand", () => {
  // Held frame sits 0.6s ahead of the clock. Uncompensated that is far outside
  // tolerance, so it would never release; against a measured 0.6s baseline it is
  // exactly on time and must paint.
  assert.equal(clock.shouldReleaseHeldFrame({ frameSourceTime: 1.6, clockSourceTime: 1.0, lagOffset: 0.6 }), true);
  assert.equal(clock.shouldReleaseHeldFrame({ frameSourceTime: 1.6, clockSourceTime: 1.0 }), false);
});

test("resync is rate limited so recovery cannot become a respawn storm", () => {
  assert.equal(clock.resyncAllowed(0, 10000), true, "first resync is always allowed");
  assert.equal(clock.resyncAllowed(10000, 10100), false);
  assert.equal(clock.resyncAllowed(10000, 10800), true);
});

// Each redundant currentTime write fires `seeked`, and every `seeked` SIGKILLs
// and respawns ffmpeg. trimPlaybackState returned sourceIn unconditionally, so
// the >0.001 comparison in the timeupdate handler re-armed on every tick.
test("trim clamping inside the dead band issues no seek", () => {
  const clip = { sourceInUs: 2000000, sourceOutUs: 8000000 };
  assert.equal(clock.trimClampAction(2.0, clip).seekTo, null);
  assert.equal(clock.trimClampAction(2.0000001, clip).seekTo, null, "float noise must not restart the decoder");
  assert.equal(clock.trimClampAction(2.02, clip).seekTo, null);
  assert.equal(clock.trimClampAction(5.0, clip).seekTo, null);
});

test("trim clamping still corrects a playhead genuinely outside the clip", () => {
  const clip = { sourceInUs: 2000000, sourceOutUs: 8000000 };
  assert.deepEqual(clock.trimClampAction(0.5, clip), { seekTo: 2, shouldPause: false });
});

test("reaching the out point pauses and only seeks when actually past it", () => {
  const clip = { sourceInUs: 2000000, sourceOutUs: 8000000 };
  const atOut = clock.trimClampAction(8.0, clip);
  assert.equal(atOut.shouldPause, true);
  assert.equal(atOut.seekTo, null, "already at the out point needs no seek");
  const past = clock.trimClampAction(9.5, clip);
  assert.equal(past.shouldPause, true);
  assert.equal(past.seekTo, 8);
});
