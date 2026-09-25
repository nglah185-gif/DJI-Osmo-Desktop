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

test("restoration follows detection by default and counts the log clips", () => {
  const view = options.view(starting());
  assert.equal(view.colorMode, "auto");
  assert.equal(view.manual, false);
  assert.equal(view.needsRestore, 2);
  assert.equal(view.restoreCount, 2);
  assert.equal(view.headlineKey, "batchExport.needsRestore");
});

test("choosing not to restore clears every tag and the active count", () => {
  const view = options.view(options.setColorMode(starting(), "none"));
  assert.equal(view.colorMode, "none");
  assert.equal(view.restore, false);
  // The clips still NEED restoration; the answer is simply not to do it.
  assert.equal(view.needsRestore, 2);
  assert.equal(view.restoreCount, 0);
  assert.equal(view.clips.every(clip => clip.showRestore === false), true);
  assert.equal(view.headlineKey, "batchExport.noRestore");
});

test("a manual model overrides detection for the whole selection", () => {
  const view = options.view(options.setColorMode(starting(), "action5pro"));
  assert.equal(view.manual, true);
  assert.equal(view.colorModeKey, "color.action5proRec709");
  assert.equal(view.restoreCount, 3, "a forced transform touches every clip in the selection");
  assert.equal(view.clips.every(clip => clip.showRestore === true), true);
  assert.equal(view.headlineKey, "batchExport.manualRestore");
});

test("photos are never tagged and never counted as restored", () => {
  const state = options.initialState({
    clips: [{ assetId: "p", name: "p.jpg", kind: "photo" }, { assetId: "v", name: "v.mp4", kind: "video" }],
    watermarks: WATERMARKS
  });
  const auto = options.view(state);
  assert.equal(auto.restoreCount, 0);
  assert.equal(auto.clips[0].isPhoto, true);
  assert.equal(auto.clips[0].showRestore, false);
  const manual = options.view(options.setColorMode(state, "action4"));
  assert.equal(manual.restoreCount, 1);
  assert.deepEqual(manual.clips.map(clip => clip.showRestore), [false, true]);
});

test("an unknown colour mode falls back to detection", () => {
  const state = starting();
  assert.equal(options.setColorMode(state, "nope").colorMode, "auto");
  assert.equal(options.setColorMode(state, undefined).colorMode, "auto");
  assert.equal(options.setColorMode(state, "").colorMode, "auto");
  assert.equal(options.COLOR_TRANSFORMS.includes("action4"), true);
});

test("a no-op toggle returns the same object so the DOM is not repainted", () => {
  const state = starting();
  assert.equal(options.setColorMode(state, "auto"), state);
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
