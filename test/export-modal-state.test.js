"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const state = require("../src/renderer/export-modal-state");

function starting(overrides = {}) {
  return state.initialState({ assetId: "a1", assetName: "DJI_0368.MP4", destination: "C:\\out\\DJI_0368.phase4.mp4", ...overrides });
}

test("a fresh dialog is indeterminate and shows no percentage", () => {
  const view = state.view(starting());
  assert.equal(view.phase, "preparing");
  assert.equal(view.indeterminate, true);
  assert.equal(view.percentText, "");
  assert.equal(view.statusKey, "exportModal.preparing");
});

test("the destination-only first message does not read as 0 percent", () => {
  // main.js sends { destination } before any pct arrives. Coercing that
  // absent pct to 0 would draw a determinate bar that has not started.
  const next = state.applyDestination(starting({ destination: "" }), "C:\\out\\DJI_0368.phase4.mp4");
  assert.equal(next.pct, null);
  assert.equal(state.view(next).indeterminate, true);
  assert.equal(state.view(next).destinationDir, "C:\\out");
  assert.equal(state.view(next).destinationName, "DJI_0368.phase4.mp4");
});

test("a real zero percent report switches the bar to determinate", () => {
  const view = state.view(state.applyProgress(starting(), 0));
  assert.equal(view.indeterminate, false);
  assert.equal(view.percentText, "0%");
  assert.equal(view.phase, "encoding");
});

test("progress is clamped and rounded for display", () => {
  assert.equal(state.applyProgress(starting(), 143).pct, 100);
  assert.equal(state.applyProgress(starting(), -8).pct, 0);
  assert.equal(state.view(state.applyProgress(starting(), 41.6)).percentText, "42%");
});

test("100 percent from ffmpeg means finalizing, not done", () => {
  // Encoding ends before ffprobe validation and the atomic rename, so the
  // dialog must not claim success while the file is still being moved.
  const view = state.view(state.applyProgress(starting(), 100));
  assert.equal(view.phase, "finalizing");
  assert.equal(view.statusKey, "exportModal.finalizing");
  assert.equal(view.cancelHidden, false);
  assert.equal(view.revealHidden, true);
});

test("a settled dialog ignores late progress messages", () => {
  const done = state.applyDone(starting(), { outputPath: "C:\\out\\DJI_0368.phase4.mp4", validation: { format: { size: 5 * 1024 * 1024 } } });
  assert.equal(state.applyProgress(done, 12).phase, "done");
  assert.equal(state.applyProgress(state.applyCanceled(starting()), 80).phase, "canceled");
  assert.equal(state.applyProgress(state.applyError(starting(), "boom"), 80).phase, "error");
});

test("completion swaps the estimate for the probed size and offers reveal", () => {
  const withEstimate = { ...starting(), estimatedBytes: 9 * 1024 * 1024 };
  assert.equal(state.view(withEstimate).sizeIsEstimate, true);
  const view = state.view(state.applyDone(withEstimate, { outputPath: "C:\\out\\final.mp4", validation: { format: { size: 12_582_912 } } }));
  assert.equal(view.sizeText, "12.0 MB");
  assert.equal(view.sizeIsEstimate, false);
  assert.equal(view.destination, "C:\\out\\final.mp4");
  assert.equal(view.barWidth, "100%");
  assert.equal(view.revealHidden, false);
  assert.equal(view.cancelHidden, true);
  assert.equal(view.closeHidden, false);
});

test("a missing probe size keeps the estimate rather than showing nothing", () => {
  const withEstimate = { ...starting(), estimatedBytes: 9 * 1024 * 1024 };
  const view = state.view(state.applyDone(withEstimate, { outputPath: "C:\\out\\final.mp4", validation: null }));
  assert.equal(view.sizeText, "9.0 MB");
  assert.equal(view.sizeIsEstimate, true);
});

test("size estimation scales with duration and ignores unusable inputs", () => {
  const bytes = state.estimateOutputBytes({ durationSeconds: 43, videoBitrate: 130_000_000, audioBitrate: 128_000 });
  assert.equal(bytes, Math.round(43 * (130_000_000 * state.ESTIMATE_VIDEO_FACTOR + 128_000) / 8));
  // A missing audio track is normal; a missing duration or bitrate is not
  // estimable and must yield null instead of a misleading zero.
  assert.ok(state.estimateOutputBytes({ durationSeconds: 43, videoBitrate: 130_000_000 }) > 0);
  assert.equal(state.estimateOutputBytes({ durationSeconds: null, videoBitrate: 130_000_000 }), null);
  assert.equal(state.estimateOutputBytes({ durationSeconds: 43, videoBitrate: 0 }), null);
});

test("byte formatting picks units and rejects unusable values", () => {
  assert.equal(state.formatBytes(512), "512 B");
  assert.equal(state.formatBytes(2048), "2 KB");
  assert.equal(state.formatBytes(3.5 * 1024 * 1024), "3.5 MB");
  assert.equal(state.formatBytes(2 * 1024 * 1024 * 1024), "2.00 GB");
  assert.equal(state.formatBytes(null), null);
  assert.equal(state.formatBytes(0), null);
});

test("path splitting handles both separators and a bare file name", () => {
  assert.equal(state.fileNameFromPath("/home/u/out/a.mp4"), "a.mp4");
  assert.equal(state.directoryFromPath("/home/u/out/a.mp4"), "/home/u/out");
  assert.equal(state.fileNameFromPath("a.mp4"), "a.mp4");
  assert.equal(state.directoryFromPath("a.mp4"), "");
  assert.equal(state.fileNameFromPath(""), "");
});

test("a failed export surfaces its message and hides reveal", () => {
  const view = state.view(state.applyError(state.applyProgress(starting(), 30), "ffmpeg exited with 1"));
  assert.equal(view.statusKey, "exportModal.failed");
  assert.equal(view.errorMessage, "ffmpeg exited with 1");
  assert.equal(view.revealHidden, true);
  assert.equal(view.closeHidden, false);
  assert.equal(view.indeterminate, false);
});

test("the cover url is attached once the poster resolves", () => {
  assert.equal(state.view(starting()).coverUrl, null);
  assert.equal(state.view(state.applyCover(starting(), "media://poster/a1")).coverUrl, "media://poster/a1");
});
