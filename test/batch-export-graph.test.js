"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { technicalTransformFor } = require("../src/color/auto-restore");
const { createEditorEffectGraph } = require("../src/color/editor-effect-graph");
const { planExport, PASSTHROUGH, TRANSCODE } = require("../src/renderers/export-plan");
const { buildFilterGraph } = require("../src/renderers/filter-graph-builder");

// Mirrors main.js batchAutoEditor. The two-line shape is the contract between
// the export IPC and the graph builder: a batch must produce the same graph a
// single export of the same clip would, or the file changes depending on how it
// was exported.
function batchAutoEditor(asset, { colorRestore = true, watermark = null } = {}) {
  return {
    technicalTransform: colorRestore ? technicalTransformFor(asset) : "none",
    creativeLook: "",
    watermark: watermark ? { ...watermark, enabled: true } : { enabled: false }
  };
}

const DLOG_ACTION4 = { cameraModel: "DJI Osmo Action 4 / HG302", djiColorMode: "D-Log M" };
const STANDARD_ACTION4 = { cameraModel: "DJI Osmo Action 4 / HG302", djiColorMode: "Standard" };

test("a D-Log clip in a batch is planned as a transcode, not a copy", () => {
  const plan = planExport({ graph: createEditorEffectGraph(batchAutoEditor(DLOG_ACTION4)) });
  assert.equal(plan.mode, TRANSCODE);
  // The specific trigger matters: "transcode for some other reason" would pass
  // a mode check while the LUT was silently missing.
  assert.ok(plan.reasons.includes("color-transform"), plan.reasons.join(","));
});

test("a Standard clip in a batch stays on the passthrough path", () => {
  const plan = planExport({ graph: createEditorEffectGraph(batchAutoEditor(STANDARD_ACTION4)) });
  assert.equal(plan.mode, PASSTHROUGH);
});

test("turning restoration off returns even D-Log clips to the passthrough path", () => {
  const plan = planExport({ graph: createEditorEffectGraph(batchAutoEditor(DLOG_ACTION4, { colorRestore: false })) });
  assert.equal(plan.mode, PASSTHROUGH);
});

test("the batch's D-Log graph actually carries the camera's Rec.709 LUT", async () => {
  const profile = createEditorEffectGraph(batchAutoEditor(DLOG_ACTION4)).colorTransform.colorProfile;
  const entry = {
    resourceId: profile.technicalTransformId,
    availability: "OFFICIAL_PIPELINE",
    role: "TECHNICAL_TRANSFORM",
    cameraFamily: profile.cameraFamily,
    sha256: profile.technicalTransformSha256,
    format: "CUBE",
    path: "C:/luts/action4.cube"
  };
  const lutRegistry = { get: id => (id === entry.resourceId ? entry : null) };
  const built = await buildFilterGraph({ graph: createEditorEffectGraph(batchAutoEditor(DLOG_ACTION4)), lutRegistry, styleRegistry: null, cacheRoot: "C:/cache" });
  assert.match(built.filterGraph, /lut3d=file=/, built.filterGraph);
});

test("the batch graph for a Standard clip emits no LUT stage", async () => {
  const built = await buildFilterGraph({ graph: createEditorEffectGraph(batchAutoEditor(STANDARD_ACTION4)), lutRegistry: { get: () => null }, styleRegistry: null, cacheRoot: "C:/cache" });
  assert.doesNotMatch(built.filterGraph, /lut3d=/, built.filterGraph);
});
