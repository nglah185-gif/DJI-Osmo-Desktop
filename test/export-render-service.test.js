"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ColorRenderService } = require("../src/renderers/color-render-service");
const { FfmpegExportRenderer, progressPercent, run } = require("../src/renderers/ffmpeg-export-renderer");
const { EventEmitter } = require("node:events");
const { createEffectGraph } = require("../src/color/effect-graph");

test("exportOriginal forwards the complete clip contract", async () => {
  const service = new ColorRenderService({ root: "C:/workspace", lutRegistry: {}, styleRegistry: null });
  let received = null;
  service.exportRenderer = { render: async args => { received = args; return { outputPath: args.outputPath }; } };
  const clip = { sourceInUs: 200000, sourceOutUs: 900000, playbackRate: 0.5, volume: 0.7, muted: false };
  await service.exportOriginal("C:/in.mp4", "C:/out.mp4", { version: 1 }, null, null, clip);
  assert.equal(received.clip, clip);
  assert.equal(received.inputPath, "C:/in.mp4");
  assert.equal(received.outputPath, "C:/out.mp4");
});

test("default export paths preserve distinct Unicode asset names and remove invalid characters", () => {
  const service = new ColorRenderService({ root: "C:/workspace", lutRegistry: {}, styleRegistry: null });
  const normal = service.defaultExportPath("普通色彩.MP4", "phase4", "C:/exports");
  const highRate = service.defaultExportPath("高帧率.MP4", "phase4", "C:/exports");
  assert.notEqual(normal, highRate);
  assert.equal(path.basename(normal), "普通色彩.phase4.mp4");
  assert.equal(path.basename(service.defaultExportPath("bad:name?.MP4", "phase:4", "C:/exports")), "bad_name_.phase_4.mp4");
});

test("export rejects source overwrite and empty clip ranges before spawning ffmpeg", async () => {
  const renderer = new FfmpegExportRenderer();
  const graph = createEffectGraph();
  await assert.rejects(() => renderer.render({ inputPath: "C:/same.mp4", outputPath: "C:/same.mp4", graph, lutRegistry: {} }), /different from the source/);
  await assert.rejects(() => renderer.render({ inputPath: "C:/input.mp4", outputPath: "C:/out.mp4", graph, lutRegistry: {}, clip: { sourceInUs: 10, sourceOutUs: 10 } }), /duration must be greater than zero/);
  await assert.rejects(() => renderer.render({ inputPath: "C:/input.mp4", outputPath: "C:/out.mp4", graph, lutRegistry: {}, clip: { sourceInUs: 0, sourceOutUs: 10, playbackRate: 0 } }), /playback rate must be greater than zero/);
});

test("export progress maps ffmpeg microseconds to a bounded percent", () => {
  assert.equal(progressPercent(0, 2), 0);
  assert.equal(progressPercent(1000000, 2), 50);
  assert.equal(progressPercent(3000000, 2), 100);
  assert.equal(progressPercent(1, null), null);
});

test("export runner aborts ffmpeg without reporting completion", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.kill = () => { child.killCalls++; child.emit("close", 137); return true; };
  const controller = new AbortController();
  const progress = [];
  const pending = run("ffmpeg", [], { signal: controller.signal, durationSeconds: 2, onProgress: value => progress.push(value), spawnProcess: () => child });
  controller.abort();
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.equal(child.killCalls, 1);
  assert.deepEqual(progress, []);
});
