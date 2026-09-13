"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ColorRenderService } = require("../src/renderers/color-render-service");
const { FfmpegExportRenderer, progressPercent, resolveProgressDuration, resolveEncodeDuration, run, audioTempoFilters, buildExportArgs, buildCopyArgs } = require("../src/renderers/ffmpeg-export-renderer");
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

test("a batch export takes its output duration from the probe", () => {
  // Without a clip the caller supplies no duration, and a graph with a looped
  // still (the watermark overlay, a HALD LUT) then never ends. Measured before
  // the fix: a 5 MB clip produced a 457 MB file that was still growing.
  assert.equal(resolveEncodeDuration({ sourceDuration: null, probeDuration: 43.6 }), 43.6);
  assert.equal(resolveEncodeDuration({ sourceDuration: 5, probeDuration: 43.6 }), 5, "an explicit duration wins");
  assert.equal(resolveEncodeDuration({ sourceDuration: null, probeDuration: null }), null);
  assert.equal(resolveEncodeDuration({ sourceDuration: null, probeDuration: 0 }), null);
});

test("a bounded export carries -t so a looped watermark cannot run forever", () => {
  const args = buildExportArgs({ encoder: null, inputPath: "C:/in.mp4", outputPath: "C:/out.mp4", filterGraph: "[0:v]null[outv]", sourceIn: 0, sourceDuration: 9.23, speed: 1, muted: true, volume: 1, audioMode: "drop" });
  const at = args.indexOf("-t");
  assert.ok(at >= 0, "the encoder command must carry -t");
  assert.equal(args[at + 1], "9.23");
});

test("a batch export measures progress against the probed duration", () => {
  // A batch passes no clip and no duration, so the progress clock used to be
  // null and the render loop emitted nothing: the bar sat at 0% and then jumped
  // to done. The probe's duration is the honest replacement.
  assert.equal(resolveProgressDuration({ outputDuration: null, probeDuration: 43.6, speed: 1 }), 43.6);
  assert.equal(resolveProgressDuration({ outputDuration: null, probeDuration: 87.2, speed: 2 }), 43.6);
  assert.equal(resolveProgressDuration({ outputDuration: 5, probeDuration: 43.6, speed: 1 }), 5, "an explicit duration wins");
  assert.equal(resolveProgressDuration({ outputDuration: null, probeDuration: null, speed: 1 }), null);
  assert.equal(resolveProgressDuration({ outputDuration: null, probeDuration: 0, speed: 1 }), null);
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

test("an already-aborted signal is honored without hanging the export", async () => {
  // A child may emit close synchronously from kill(). If the signal handler ran
  // before the listeners were attached, that close would be lost and the export
  // would never settle.
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.emit("close", 137); return true; };
  const controller = new AbortController();
  controller.abort();
  const result = await run("ffmpeg", [], { signal: controller.signal, spawnProcess: () => child });
  assert.equal(result.aborted, true);
});

test("a wedged probe is killed by its deadline instead of hanging the export", async () => {
  // ffmpeg can stall before printing anything when a GPU driver is wedged. The
  // probe must give up so the export can fall back, rather than waiting forever.
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const started = Date.now();
  const result = await run("ffmpeg", [], { spawnProcess: () => child, timeoutMs: 60 });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.ok(Date.now() - started < 3000, "deadline should fire promptly, not block");
});

test("atempo stays inside the single-filter range by chaining stages", () => {
  // Verified against the bundled ffmpeg: atempo accepts [0.5, 100] and rejects
  // the entire command outside it. A 0.25x slow-motion export used to fail with
  // "Value 0.250000 for parameter 'tempo' out of range [0.5 - 100]".
  assert.deepEqual(audioTempoFilters(1), []);

  const slow = audioTempoFilters(0.25);
  assert.equal(slow.join(","), "atempo=0.5,atempo=0.500000");
  const fast = audioTempoFilters(4);
  assert.equal(fast.join(","), "atempo=2,atempo=2.000000");

  // Every emitted stage must itself be legal, and the stages must multiply back
  // to the requested rate.
  for (const rate of [0.1, 0.25, 0.5, 1.5, 2, 4, 8, 0.75]) {
    const filters = audioTempoFilters(rate);
    assert.ok(filters.length > 0, rate + " should produce at least one stage");
    const product = filters.reduce((value, filter) => value * Number(filter.split("=")[1]), 1);
    assert.ok(Math.abs(product - rate) < 1e-4, rate + " product was " + product);
    for (const filter of filters) {
      const stage = Number(filter.split("=")[1]);
      assert.ok(stage >= 0.5 && stage <= 2, "stage out of the portable range: " + filter);
    }
  }
});

test("an absurd playback rate cannot emit an unbounded filter chain", () => {
  const filters = audioTempoFilters(1e-300);
  assert.ok(filters.length <= 32, "got " + filters.length + " stages");
  for (const filter of filters) {
    const stage = Number(filter.split("=")[1]);
    assert.ok(stage >= 0.5 && stage <= 2);
  }
});

test("both export paths preserve source metadata", () => {
  // Measured: without -map_metadata 0 the camera's creation_time and the stream
  // timecode tag are dropped, and encoder=Lavf... replaces the original. That is
  // data loss for a media tool -- creation_time is how a clip's shoot time is
  // preserved.
  const transcode = buildExportArgs({
    encoder: null, inputPath: "C:/in.mp4", outputPath: "C:/out.mp4",
    filterGraph: "[0:v]null[outv]", speed: 1, muted: false, volume: 1, audioMode: "copy"
  });
  const mapMetadataAt = transcode.indexOf("-map_metadata");
  assert.ok(mapMetadataAt >= 0, "transcode must map input metadata");
  assert.equal(transcode[mapMetadataAt + 1], "0");

  const copy = buildCopyArgs({ inputPath: "C:/in.mp4", outputPath: "C:/out.mp4" });
  const copyAt = copy.indexOf("-map_metadata");
  assert.ok(copyAt >= 0, "copy must map input metadata");
  assert.equal(copy[copyAt + 1], "0");
});
