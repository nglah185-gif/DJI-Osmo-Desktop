"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { gpuLutFilter, hasGpuLutFilter, isGpuLutFailure, GpuLutSupport } = require("../src/renderers/gpu-lut");
const { buildFilterGraph } = require("../src/renderers/filter-graph-builder");
const { createEditorEffectGraph } = require("../src/color/editor-effect-graph");
const { technicalTransformFor } = require("../src/color/auto-restore");

const DLOG = { cameraModel: "DJI Osmo Action 4 / HG302", djiColorMode: "D-Log M" };
function dlogGraph() {
  return createEditorEffectGraph({ technicalTransform: technicalTransformFor(DLOG), creativeLook: "", watermark: { enabled: false } });
}
const LUT_ENTRY = {
  resourceId: "action4.dlogm.rec709.website-cube",
  availability: "OFFICIAL_PIPELINE",
  role: "TECHNICAL_TRANSFORM",
  cameraFamily: "Action4",
  sha256: "B18162854AB47702068410C33AFA98A8CB6EEF159FC5A04CE0E65FAD0FD8947E",
  format: "CUBE",
  path: "C:/luts/action 4.cube"
};
const registry = { get: id => (id === LUT_ENTRY.resourceId ? LUT_ENTRY : null) };

test("the GPU filter asks for normalized LUT input and escapes the path", () => {
  assert.equal(gpuLutFilter("C:\\luts\\action 4.cube"), "libplacebo=lut='C\\:/luts/action 4.cube':lut_type=2");
  assert.equal(gpuLutFilter("E:\\a'b.cube"), "libplacebo=lut='E\\:/a\\'b.cube':lut_type=2");
});

test("a build is judged by its filter list, not by its name", () => {
  assert.equal(hasGpuLutFilter(" .. libplacebo        N->V  Apply various GPU filters"), true);
  assert.equal(hasGpuLutFilter(" T. lut3d             V->V   Adjust colors"), false);
  assert.equal(hasGpuLutFilter(null), false);
});

test("only GPU/Vulkan errors trigger the CPU retry", () => {
  assert.equal(isGpuLutFailure("Failed creating Vulkan device!"), true);
  assert.equal(isGpuLutFailure("[libplacebo] pl_gpu: no device"), true);
  assert.equal(isGpuLutFailure("Error initializing filter 'libplacebo'"), true);
  // A missing filter is also a GPU-LUT failure: the CPU path is the answer.
  assert.equal(isGpuLutFailure("No such filter: 'libplacebo'"), true);
  assert.equal(isGpuLutFailure("Error while opening encoder"), false);
  assert.equal(isGpuLutFailure("Cannot allocate memory"), false);
});

test("the CUBE stage switches engine without changing the rest of the graph", async () => {
  const cpu = await buildFilterGraph({ graph: dlogGraph(), lutRegistry: registry, styleRegistry: null, cacheRoot: "C:/cache", lutEngine: "cpu" });
  const gpu = await buildFilterGraph({ graph: dlogGraph(), lutRegistry: registry, styleRegistry: null, cacheRoot: "C:/cache", lutEngine: "gpu" });
  assert.match(cpu.filterGraph, /lut3d=file=/);
  assert.doesNotMatch(cpu.filterGraph, /libplacebo/);
  assert.match(gpu.filterGraph, /libplacebo=lut=/);
  assert.doesNotMatch(gpu.filterGraph, /lut3d=file=/);
  // Everything else about the export must be identical.
  assert.equal(gpu.filterGraph.replace(/libplacebo=lut='[^']*':lut_type=2/, "LUT"), cpu.filterGraph.replace(/lut3d=file='[^']*'/, "LUT"));
});

test("HALD transforms stay on the CPU because libplacebo takes .cube only", async () => {
  const hald = { ...LUT_ENTRY, format: "HALD", sha256: LUT_ENTRY.sha256 };
  const built = await buildFilterGraph({ graph: dlogGraph(), lutRegistry: { get: () => hald }, styleRegistry: null, cacheRoot: "C:/cache", lutEngine: "gpu" });
  assert.match(built.filterGraph, /haldclut/);
  assert.doesNotMatch(built.filterGraph, /libplacebo/);
});

test("support is probed once and remembered", async () => {
  let calls = 0;
  const support = new GpuLutSupport({ ffmpegPath: "ffmpeg", runFfmpeg: async () => { calls++; return { code: 0, stdout: " .. libplacebo  N->V  Apply" }; } });
  assert.equal(await support.available(), true);
  assert.equal(await support.available(), true);
  assert.equal(calls, 1, "the probe must not run twice");
});

test("a build without libplacebo is remembered as unavailable", async () => {
  let calls = 0;
  const support = new GpuLutSupport({ ffmpegPath: "ffmpeg", runFfmpeg: async () => { calls++; return { code: 0, stdout: " T. lut3d  V->V  Adjust colors" }; } });
  assert.equal(await support.available(), false);
  assert.equal(await support.available(), false);
  assert.equal(calls, 1);
});

test("a wedged probe falls back instead of throwing", async () => {
  const support = new GpuLutSupport({ ffmpegPath: "ffmpeg", runFfmpeg: async () => { throw new Error("spawn failed"); } });
  assert.equal(await support.available(), false);
});

test("a failed export can disable the GPU path for the rest of the session", async () => {
  const support = new GpuLutSupport({ ffmpegPath: "ffmpeg", runFfmpeg: async () => ({ code: 0, stdout: "libplacebo" }) });
  assert.equal(await support.available(), true);
  support.disable();
  assert.equal(await support.available(), false);
});
