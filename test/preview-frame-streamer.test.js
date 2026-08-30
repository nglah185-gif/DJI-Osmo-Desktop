"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PreviewFrameStreamer, playbackPacing } = require("../src/renderers/preview-frame-streamer");
const { previewFitFilter } = require("../src/renderers/preview-fit");

test("preview fit preserves rotated aspect ratio inside a fixed frame", () => {
  assert.equal(previewFitFilter(640, 360), ",scale=640:360:force_original_aspect_ratio=increase,crop=640:360:(iw-ow)/2:(ih-oh)/2,setsar=1");
  assert.equal(previewFitFilter(0, 360), "");
});

test("preview seek clamps to the final decodable frame", () => {
  const streamer = new PreviewFrameStreamer({ frameRate: 30 });
  const editor = { clip: { sourceInUs: 0, sourceOutUs: 3403400, playbackRate: 1 } };
  const seconds = streamer._mapSeconds(3.413333, editor, 30);
  assert.ok(seconds < 3.4034);
  assert.equal(seconds, 3.4034 - 1 / 30);
});

test("preview seek respects trim-in and playback rate", () => {
  const streamer = new PreviewFrameStreamer({ frameRate: 30 });
  const editor = { clip: { sourceInUs: 2000000, sourceOutUs: 10000000, playbackRate: 2 } };
  assert.equal(streamer._mapSeconds(1.5, editor, 30), 5);
  assert.equal(streamer._mapSeconds(-20, editor, 30), 2);
});

test("preview pacing slows frame delivery and skips frames for fast playback", () => {
  assert.deepEqual(playbackPacing(30, 0.5), { intervalMs: 1000 / 15, frameStep: 1 });
  assert.deepEqual(playbackPacing(30, 1), { intervalMs: 1000 / 30, frameStep: 1 });
  assert.deepEqual(playbackPacing(30, 2), { intervalMs: 1000 / 30, frameStep: 2 });
});

test("effect update and seek refresh a paused preview", async () => {
  const streamer = new PreviewFrameStreamer();
  const session = { assetId: "x", editor: { clip: {} }, paused: true, frameRate: 30 };
  streamer.sessions.set("x", session);
  let launches = 0;
  streamer._enqueueLaunch = async current => {
    launches++;
    assert.equal(current.paused, false);
  };
  await streamer.update("x", { editor: { clip: {} }, graph: {}, timelineSeconds: 2 });
  session.paused = true;
  await streamer.seek("x", 3);
  assert.equal(launches, 2);
});

function fakeChild(overrides = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = 0;
  child.kill = () => { child.killCalls++; return true; };
  return Object.assign(child, overrides);
}

test("preview cleanup resolves when a child already exited before cleanup", async () => {
  const streamer = new PreviewFrameStreamer();
  const child = fakeChild({ exitCode: 0 });
  const session = { child, stopping: false, paceTimer: setTimeout(() => {}, 10000) };
  await streamer._killChild(session);
  assert.equal(session.child, null);
  assert.equal(session.paceTimer, null);
  assert.equal(child.killCalls, 0);
});

test("preview cleanup resolves when Windows refuses a stale process handle", async () => {
  const streamer = new PreviewFrameStreamer();
  const child = fakeChild({ kill() { this.killCalls++; return false; } });
  const session = { child, stopping: false };
  await streamer._killChild(session);
  assert.equal(session.child, null);
  assert.equal(child.killCalls, 1);
});

test("synchronous shutdown kills every preview process and clears timers", () => {
  const streamer = new PreviewFrameStreamer();
  const first = fakeChild();
  const second = fakeChild();
  const one = { child: first, paceTimer: setTimeout(() => {}, 10000) };
  const two = { child: second, paceTimer: setTimeout(() => {}, 10000) };
  streamer.sessions.set("one", one);
  streamer.sessions.set("two", two);
  streamer.shutdownNow();
  assert.equal(streamer.sessions.size, 0);
  assert.equal(first.killCalls, 1);
  assert.equal(second.killCalls, 1);
  assert.equal(one.paceTimer, null);
  assert.equal(two.paceTimer, null);
});

test("late stdout from a replaced ffmpeg child cannot paint stale frames", async () => {
  const children = [];
  const spawnProcess = () => {
    const child = fakeChild();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.kill = () => {
      child.killCalls++;
      child.exitCode = 1;
      child.emit("close", 1);
      return true;
    };
    children.push(child);
    return child;
  };
  const frames = [];
  const streamer = new PreviewFrameStreamer({ width: 2, height: 1, hardwareDecode: false, spawnProcess });
  const webContents = { isDestroyed: () => false, send: (_name, frame) => frames.push(frame) };
  const editor = { clip: { sourceInUs: 0, sourceOutUs: 1000000, playbackRate: 1 } };
  await streamer.start({ assetId: "race", sourcePath: "sample.mp4", editor, graph: {}, webContents });
  const oldChild = children[0];
  await streamer.update("race", { editor, graph: {}, timelineSeconds: 0 });
  const newChild = children[1];
  oldChild.stdout.emit("data", Buffer.alloc(6, 1));
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(frames.length, 0);
  newChild.stdout.emit("data", Buffer.alloc(6, 2));
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data[0], 2);
  assert.equal(frames[0].launchGeneration, 2);
  await streamer.stop("race");
});

test("replacement launch does not wait for a stale Windows close event", async () => {
  const children = [];
  const spawnProcess = () => {
    const child = fakeChild();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.kill = () => true;
    children.push(child);
    return child;
  };
  const streamer = new PreviewFrameStreamer({
    spawnProcess,
    lutRegistry: { resolve: () => null },
    width: 2,
    height: 2
  });
  const webContents = { isDestroyed: () => false, send() {} };
  const editor = { clip: { sourceInUs: 0, sourceOutUs: 1000000, playbackRate: 1 } };
  await streamer.start({ assetId: "a", sourcePath: "x.lrf", editor, graph: {}, webContents });
  const first = children[0];
  const started = Date.now();
  await streamer.update("a", { editor, graph: { changed: true }, timelineSeconds: 0 });
  assert.ok(Date.now() - started < 500);
  assert.equal(children.length, 2);
  first.emit("close", 0);
  await streamer.stop("a");
});

test("stop invalidates a session without waiting for a stuck launch", async () => {
  const streamer = new PreviewFrameStreamer();
  const child = fakeChild({ exitCode: 0 });
  const never = new Promise(() => {});
  const session = {
    assetId: "stuck",
    child,
    launchPromise: never,
    paused: false,
    closed: false,
    stopping: false
  };
  streamer.sessions.set("stuck", session);
  const started = Date.now();
  const result = await streamer.stop("stuck");
  assert.ok(Date.now() - started < 250, "stop should not inherit a stuck launch wait");
  assert.deepEqual(result, { stopped: true, assetId: "stuck" });
  assert.equal(streamer.sessions.has("stuck"), false);
  assert.equal(session.closed, true);
  assert.equal(session.paused, true);
});

test("queued preview launches collapse to the latest request", async () => {
  const streamer = new PreviewFrameStreamer();
  const session = { assetId: "latest", launchGeneration: 0, launchRequestGeneration: 0 };
  let releaseFirst;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  let launches = 0;
  streamer._launch = async () => {
    launches++;
    if (launches === 1) await firstBlocked;
    return { launchGeneration: launches };
  };

  const first = streamer._enqueueLaunch(session);
  await new Promise(resolve => setImmediate(resolve));
  const intermediate = streamer._enqueueLaunch(session);
  const latest = streamer._enqueueLaunch(session);
  releaseFirst();

  const results = await Promise.all([first, intermediate, latest]);
  assert.equal(launches, 2);
  assert.equal(results[1].skipped, true);
  assert.equal(results[2].launchGeneration, 2);
});

function captureArgs() {
  const calls = [];
  const spawnProcess = (_bin, args) => {
    const child = fakeChild();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.kill = () => { child.killCalls++; child.exitCode = 1; child.emit("close", 1); return true; };
    calls.push(args);
    return child;
  };
  return { calls, spawnProcess };
}

test("preview decode is rate limited to playback speed as an input option", async () => {
  const { calls, spawnProcess } = captureArgs();
  const streamer = new PreviewFrameStreamer({ width: 2, height: 1, hardwareDecode: false, spawnProcess });
  const webContents = { isDestroyed: () => false, send: () => {} };
  const editor = { clip: { sourceInUs: 0, sourceOutUs: 4000000, playbackRate: 1 } };
  await streamer.start({ assetId: "rate", sourcePath: "sample.mp4", editor, graph: {}, webContents });

  const args = calls[0];
  const rateIndex = args.indexOf("-readrate");
  assert.ok(rateIndex >= 0, "-readrate must be present so decode cannot outrun the consumer");
  // An input option only applies when it precedes -i.
  assert.ok(rateIndex < args.indexOf("-i"), "-readrate must precede -i to bind to the input");
  // Exactly playback speed, with no margin. A margin lets the decoder outrun the
  // 1x consumer permanently, which pushes reported sourceTime past the resync
  // threshold and freezes the canvas. Pacing is closed-loop via reportClock().
  assert.equal(Number(args[rateIndex + 1]), 1);
  // Burst only enough to fill the small queue after a seek.
  assert.equal(args[args.indexOf("-readrate_initial_burst") + 1], "0.15");
  await streamer.stop("rate");
});

test("read rate scales with playback rate and stays bounded", async () => {
  const { calls, spawnProcess } = captureArgs();
  const streamer = new PreviewFrameStreamer({ width: 2, height: 1, hardwareDecode: false, spawnProcess });
  const webContents = { isDestroyed: () => false, send: () => {} };
  const readRateFor = async (assetId, playbackRate) => {
    const editor = { clip: { sourceInUs: 0, sourceOutUs: 4000000, playbackRate } };
    await streamer.start({ assetId, sourcePath: "sample.mp4", editor, graph: {}, webContents });
    const args = calls[calls.length - 1];
    const rate = Number(args[args.indexOf("-readrate") + 1]);
    await streamer.stop(assetId);
    return rate;
  };

  // 4x playback drains 4 source frames per tick, so decode scales with it -- at
  // exactly playback speed, with no margin.
  assert.ok(Math.abs(await readRateFor("fast", 4) - 4) < 1e-6);
  // Slow motion must not stall below a usable floor.
  assert.ok(await readRateFor("slow", 0.25) >= 0.25);
  // An absurd rate is clamped instead of becoming unbounded decode.
  assert.equal(await readRateFor("absurd", 999), 16);
});
