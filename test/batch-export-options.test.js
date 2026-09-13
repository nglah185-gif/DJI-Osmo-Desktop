"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const options = require("../src/renderer/batch-export-options");

const WATERMARKS = [{ id: "action4.official.oa4", name: "OA4" }, { id: "action4.official.oa4.borderless", name: "OA4 borderless" }];

function starting(patch = {}) {
  return options.initialState({
    clips: [
      { assetId: "a", name: "a.mp4", needsRestore: true },
      { assetId: "b", name: "b.mp4", needsRestore: false },
      { assetId: "c", name: "c.mp4", needsRestore: true }
    ],
    watermarks: WATERMARKS,
    destination: "D:\\out",
    skipped: 1,
    ...patch
  });
}

test("the setup sheet lists every clip and carries the destination", () => {
  const view = options.view(starting());
  assert.equal(view.total, 3);
  assert.equal(view.skipped, 1);
  assert.equal(view.destination, "D:\\out");
  assert.deepEqual(view.clips.map(clip => clip.name), ["a.mp4", "b.mp4", "c.mp4"]);
});

test("restoration is on by default and counts only the D-Log clips", () => {
  const view = options.view(starting());
  assert.equal(view.restore, true);
  assert.equal(view.needsRestore, 2);
  assert.equal(view.restoreCount, 2);
});

test("turning restoration off clears every restore tag and the active count", () => {
  const state = options.setRestore(starting(), false);
  const view = options.view(state);
  assert.equal(view.restore, false);
  // The clips still NEED restoration; the answer is simply not to do it.
  assert.equal(view.needsRestore, 2);
  assert.equal(view.restoreCount, 0);
  assert.equal(view.clips.every(clip => clip.showRestore === false), true);
});

test("a no-op toggle returns the same object so the DOM is not repainted", () => {
  const state = starting();
  assert.equal(options.setRestore(state, true), state);
  assert.equal(options.setWatermarkEnabled(state, false), state);
  assert.equal(options.setWatermarkId(state, "action4.official.oa4"), state);
});

test("the watermark option cannot be enabled without a badge to choose", () => {
  const state = starting({ watermarks: [], watermarkEnabled: true });
  assert.equal(state.watermarkEnabled, false);
  assert.equal(options.setWatermarkEnabled(state, true), state);
  assert.equal(options.view(state).watermark, null);
});

test("enabling the watermark returns the shape the export IPC expects", () => {
  let state = starting();
  assert.equal(options.view(state).watermark, null, "off by default");
  state = options.setWatermarkEnabled(state, true);
  const view = options.view(state);
  assert.equal(view.watermarkEnabled, true);
  assert.deepEqual(view.watermark, { enabled: true, id: "action4.official.oa4", scale: 0.195, opacity: 1, position: { x: 0.5, y: 1 } });
});

test("an unknown watermark id is rejected rather than exported", () => {
  const state = starting();
  assert.equal(options.setWatermarkId(state, "nope"), state);
  assert.equal(options.view(options.setWatermarkId(state, WATERMARKS[1].id)).watermarkId, WATERMARKS[1].id);
});

test("the watermark signature changes only when the badge set does", () => {
  const signature = options.view(starting()).watermarkSignature;
  assert.equal(options.view(options.setWatermarkEnabled(starting(), true)).watermarkSignature, signature);
  assert.notEqual(options.view(starting({ watermarks: [WATERMARKS[0]] })).watermarkSignature, signature);
});

test("an empty clip list disables start instead of opening a dialog that does nothing", () => {
  const view = options.view(options.initialState({ watermarks: WATERMARKS }));
  assert.equal(view.total, 0);
  assert.equal(view.startDisabled, true);
  assert.equal(options.view(starting()).startDisabled, false);
});
