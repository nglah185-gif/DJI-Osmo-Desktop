const test = require("node:test");
const assert = require("node:assert/strict");
const { numberOrDefault, watermarkFromControls, createSerialRunner, createLatestRunner, switchMode, snapshotItems, secondsFromMicroseconds, microsecondsFromSeconds, technicalForColorProfile, colorProfileForTechnical, playbackStartTime, previewTimelineSeconds, exportDurationSeconds, trimPlaybackState, displayResolution, selectionInAssets, navigationState, assetControlState, emptyStateFor, shouldRenderExportFacts, isExportCanceledError, shouldResetSelectionOnSourceChange } = require("../src/renderer/editor-ui-state");

test("watermark controls preserve an explicit zero opacity", () => {
  const positions = { bottomRight: { x: 1, y: 1 } };
  const watermark = watermarkFromControls({ enabled: true, id: "wm", scale: "0.5", opacity: "0", position: "bottomRight" }, positions);
  assert.equal(watermark.opacity, 0);
  assert.equal(watermark.scale, 0.5);
  assert.deepEqual(watermark.position, { x: 1, y: 1 });
  assert.equal(numberOrDefault("", 1), 1);
});

test("serial editor runner waits for preview start before applying an update", async () => {
  const run = createSerialRunner();
  const events = [];
  let releaseStart;
  let markStarted;
  const startGate = new Promise(resolve => { releaseStart = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const start = run(async () => { events.push("start:begin"); markStarted(); await startGate; events.push("start:end"); });
  const update = run(async () => { events.push("update"); });
  await started;
  assert.deepEqual(events, ["start:begin"]);
  releaseStart();
  await Promise.all([start, update]);
  assert.deepEqual(events, ["start:begin", "start:end", "update"]);
});

test("latest editor runner drops queued intermediate updates", async () => {
  const run = createLatestRunner();
  const started = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = run(async () => { started.push("first"); await gate; });
  const second = run(async () => started.push("second"));
  const third = run(async () => started.push("third"));
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(started, ["third"]);
});

test("mode switch returns and awaits the selected async transition", async () => {
  let finished = false;
  await switchMode("edit", { edit: async () => { await Promise.resolve(); finished = true; }, browse: () => { throw new Error("wrong mode"); } });
  assert.equal(finished, true);
});

test("language refresh can render before the first scan snapshot arrives", () => {
  assert.deepEqual(snapshotItems(null, "devices"), []);
  assert.deepEqual(snapshotItems({ assets: [] }, "devices"), []);
  assert.deepEqual(snapshotItems({ devices: [{ status: "READY" }] }, "devices"), [{ status: "READY" }]);
});

test("trim controls convert editor microseconds to UI seconds without drift", () => {
  assert.equal(secondsFromMicroseconds(3400000), 3.4);
  assert.equal(microsecondsFromSeconds("3.4"), 3400000);
  assert.equal(microsecondsFromSeconds(""), 0);
});

test("source profile and technical transform stay synchronized", () => {
  assert.equal(technicalForColorProfile("action4-dlogm"), "action4");
  assert.equal(technicalForColorProfile("normal"), "none");
  assert.equal(colorProfileForTechnical("action4"), "action4-dlogm");
  assert.equal(colorProfileForTechnical("none"), "normal");
});

test("playback at the clip end restarts from trim-in", () => {
  assert.equal(playbackStartTime({ currentTime: 3.4034, ended: true, sourceIn: 0.5, sourceOut: 3.4034 }), 0.5);
  assert.equal(playbackStartTime({ currentTime: 3.4, ended: false, sourceIn: 0.5, sourceOut: 3.4034 }), 0.5);
  assert.equal(playbackStartTime({ currentTime: 2, ended: false, sourceIn: 0.5, sourceOut: 3.4034 }), 2);
});

test("media cards report display geometry for rotated portrait clips", () => {
  const portrait = { original: { probe: { width: 3840, height: 2160 } }, displayGeometry: { original: { displayWidth: 2160, displayHeight: 3840, rotation: -90 } } };
  assert.equal(displayResolution(portrait), "2160x3840");
  assert.equal(displayResolution({ original: { probe: { width: 3840, height: 2160 } } }), "3840x2160");
  assert.equal(displayResolution({ original: { probe: { width: "UNKNOWN", height: "UNKNOWN" } } }), "?");
});

test("selection and navigation derive from the active sorted list", () => {
  const assets = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(selectionInAssets(assets, "b"), true);
  assert.equal(selectionInAssets(assets, "missing"), false);
  assert.deepEqual(navigationState(assets, "a"), { previousDisabled: true, nextDisabled: false });
  assert.deepEqual(navigationState(assets, "b"), { previousDisabled: false, nextDisabled: false });
  assert.deepEqual(navigationState(assets, "c"), { previousDisabled: false, nextDisabled: true });
  assert.deepEqual(navigationState(assets, "missing"), { previousDisabled: true, nextDisabled: true });
});

test("photos and missing selections disable every editing entry point", () => {
  assert.deepEqual(assetControlState(null, false), { editingDisabled: true, watermarkStyleDisabled: true, watermarkPositionsDisabled: true, exportDisabled: true, exportAsHidden: true });
  assert.deepEqual(assetControlState({ mediaKind: "photo" }, true), { editingDisabled: true, watermarkStyleDisabled: true, watermarkPositionsDisabled: true, exportDisabled: true, exportAsHidden: true });
  assert.deepEqual(assetControlState({ mediaKind: "video" }, false), { editingDisabled: false, watermarkStyleDisabled: true, watermarkPositionsDisabled: false, exportDisabled: false, exportAsHidden: false });
  assert.equal(shouldRenderExportFacts({ mediaKind: "photo" }), false);
  assert.equal(shouldRenderExportFacts({ mediaKind: "video" }), true);
});

test("empty state distinguishes an empty filter from an empty library", () => {
  assert.deepEqual(emptyStateFor({ totalCount: 2, visibleCount: 0, filter: "photos", isLocal: true }), { hidden: false, titleKey: "filter.emptyPhotos", hintKey: "filter.emptyHint" });
  assert.deepEqual(emptyStateFor({ totalCount: 0, visibleCount: 0, filter: "all", isLocal: true }), { hidden: false, titleKey: "local.empty", hintKey: "local.emptyHint" });
  assert.deepEqual(emptyStateFor({ totalCount: 2, visibleCount: 2, filter: "all", isLocal: false }), { hidden: true });
});

test("preview clock maps trimmed source time through playback rate", () => {
  const clip = { sourceInUs: 5000000, sourceOutUs: 9000000, playbackRate: 2 };
  assert.equal(previewTimelineSeconds(5, clip), 0);
  assert.equal(previewTimelineSeconds(7, clip), 1);
  assert.equal(exportDurationSeconds(clip), 2);
});

test("trim playback stops cleanly at the out point", () => {
  const clip = { sourceInUs: 5000000, sourceOutUs: 6000000, playbackRate: 1 };
  assert.deepEqual(trimPlaybackState(4.5, clip), { currentTime: 5, shouldPause: false });
  assert.deepEqual(trimPlaybackState(5.5, clip), { currentTime: 5.5, shouldPause: false });
  assert.deepEqual(trimPlaybackState(6.01, clip), { currentTime: 6, shouldPause: true });
});

test("wrapped Electron IPC cancellation remains a normal export outcome", () => {
  assert.equal(isExportCanceledError(new Error("Export canceled")), true);
  assert.equal(isExportCanceledError(new Error("Error invoking remote method 'editor:export': Error: Export canceled")), true);
  assert.equal(isExportCanceledError(new Error("Export failed: disk full")), false);
});

test("changing library source resets the active selection", () => {
  assert.equal(shouldResetSelectionOnSourceChange("camera", "local"), true);
  assert.equal(shouldResetSelectionOnSourceChange("local", "camera"), true);
  assert.equal(shouldResetSelectionOnSourceChange("camera", "camera"), false);
});
