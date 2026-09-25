const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeVideoSpec, isDefaultVideoSpec, videoSpecGraphOptions } = require("../src/renderers/video-spec");
const { encoderPixelFormat, hardwareCandidates, hardwareEncoderArgs, encoderArgs, probeHardwareEncoder } = require("../src/renderers/encoder-selection");
const { buildExportArgs } = require("../src/renderers/ffmpeg-export-renderer");
const { buildFilterGraph } = require("../src/renderers/filter-graph-builder");
const { createEffectGraph } = require("../src/color/effect-graph");

test("an empty spec is the source-everything default", () => {
  const spec = normalizeVideoSpec();
  assert.equal(spec.resolution, "source");
  assert.equal(spec.fps, "source");
  assert.equal(spec.rate, "quality");
  assert.equal(spec.tenBit, false);
  assert.equal(spec.codec, "h264");
  assert.equal(spec.outputHeight, null);
  assert.equal(spec.outputFps, null);
  assert.equal(isDefaultVideoSpec(spec), true);
});

test("unknown values fall back to the source defaults instead of reaching ffmpeg", () => {
  const spec = normalizeVideoSpec({ resolution: "9000", fps: "13", rate: "vbr", tenBit: "yes", bitrateMbps: -4 });
  assert.equal(spec.resolution, "source");
  assert.equal(spec.fps, "source");
  assert.equal(spec.rate, "quality");
  assert.equal(spec.tenBit, false);
});

test("10-bit selects HEVC and a target bitrate becomes bits per second", () => {
  const spec = normalizeVideoSpec({ resolution: "1080", fps: "30", rate: "bitrate", bitrateMbps: 45.5, tenBit: true });
  assert.equal(spec.codec, "hevc");
  assert.equal(spec.outputHeight, 1080);
  assert.equal(spec.outputFps, 30);
  assert.equal(spec.videoBitrate, 45500000);
  assert.equal(isDefaultVideoSpec(spec), false);
  assert.deepEqual(videoSpecGraphOptions(spec), { outputHeight: 1080, outputFps: 30 });
});

test("an explicit codec choice is honoured and 10-bit H.264 is refused", () => {
  const hevc = normalizeVideoSpec({ codec: "hevc" });
  assert.equal(hevc.codec, "hevc");
  assert.equal(hevc.tenBit, false);
  assert.equal(hevc.codecChoice, "hevc");
  assert.equal(isDefaultVideoSpec(hevc), false, "an explicit codec must force a transcode");

  const h264 = normalizeVideoSpec({ codec: "h264", tenBit: true });
  assert.equal(h264.codec, "h264");
  assert.equal(h264.tenBit, false, "H.264 cannot carry 10 bits");

  const autoTenBit = normalizeVideoSpec({ codec: "auto", tenBit: true });
  assert.equal(autoTenBit.codec, "hevc");
  assert.equal(autoTenBit.tenBit, true);
});

test("8-bit HEVC keeps the 8-bit pixel format and still tags the stream", () => {
  assert.equal(encoderPixelFormat({ codec: "hevc", tenBit: false }), "yuv420p");
  const args = buildExportArgs({
    encoder: "hevc_nvenc", inputPath: "in.mp4", outputPath: "out.mp4", filterGraph: "[0:v]null[outv]",
    speed: 1, muted: true, volume: 1, platform: "win32", tenBit: false, codec: "hevc"
  });
  assert.equal(args[args.indexOf("-tag:v") + 1], "hvc1");
  assert.equal(args.includes("p010le"), false);
  assert.equal(args[args.indexOf("-pix_fmt") + 1], "yuv420p");
});

test("encoder pixel format follows codec and bit depth", () => {
  assert.equal(encoderPixelFormat(), "yuv420p");
  assert.equal(encoderPixelFormat({ codec: "h264", tenBit: false }), "yuv420p");
  assert.equal(encoderPixelFormat({ codec: "hevc", tenBit: true }), "p010le");
});

test("HEVC candidates are probed with the 10-bit pixel format", async () => {
  assert.ok(hardwareCandidates("win32", { codec: "hevc" }).includes("hevc_nvenc"));
  const args = hardwareEncoderArgs("hevc_nvenc", { tenBit: true });
  assert.deepEqual(args.slice(0, 2), ["-c:v", "hevc_nvenc"]);
  assert.equal(args.includes("p010le"), true);
  // A 10-bit probe must not spend its time on an 8-bit encoder first.
  const seen = [];
  const encoder = await probeHardwareEncoder({
    platform: "win32",
    codec: "hevc",
    tenBit: true,
    runFfmpeg: async (_command, probe) => { seen.push(probe.join(" ")); return { code: probe.includes("p010le") ? 0 : 1 }; }
  });
  assert.equal(encoder, "hevc_nvenc");
  assert.equal(seen.length, 1);
});

test("an explicit bitrate replaces the quality preset", () => {
  const args = hardwareEncoderArgs("h264_nvenc", { videoBitrate: 40000000 });
  assert.equal(args.includes("-b:v"), true);
  assert.equal(args.includes("-cq"), false);
  assert.equal(args[args.indexOf("-b:v") + 1], "40000000");
});

test("a software HEVC fallback keeps 10 bits", () => {
  const args = encoderArgs(null, { codec: "hevc", tenBit: true });
  assert.deepEqual(args.slice(0, 2), ["-c:v", "libx265"]);
  assert.equal(args[args.indexOf("-pix_fmt") + 1], "yuv420p10le");
});

test("export args tag HEVC and hand the bit depth to the encoder", () => {
  const args = buildExportArgs({
    encoder: "hevc_nvenc", inputPath: "in.mp4", outputPath: "out.mp4", filterGraph: "[0:v]null[outv]",
    speed: 1, muted: true, volume: 1, platform: "win32", tenBit: true, codec: "hevc"
  });
  assert.equal(args.includes("-tag:v"), true);
  assert.equal(args[args.indexOf("-tag:v") + 1], "hvc1");
  assert.equal(args.includes("p010le"), true);
});

test("resolution and frame rate are graph stages before the output format", async () => {
  const built = await buildFilterGraph({
    graph: createEffectGraph(),
    lutRegistry: { get: () => null },
    styleRegistry: null,
    cacheRoot: "unused",
    outputHeight: 1080,
    outputFps: 30
  });
  assert.match(built.filterGraph, /scale=-2:1080:flags=lanczos\[output_scaled\]/);
  assert.match(built.filterGraph, /fps=fps=30\[output_fps\]/);
  assert.ok(built.filterGraph.indexOf("scale=-2:1080") < built.filterGraph.indexOf("fps=fps=30"), "scale before fps");
  assert.ok(built.filterGraph.indexOf("fps=fps=30") < built.filterGraph.lastIndexOf("format="), "fps before the output format");
});

test("no video spec leaves the graph untouched", async () => {
  const built = await buildFilterGraph({ graph: createEffectGraph(), lutRegistry: { get: () => null }, styleRegistry: null, cacheRoot: "unused" });
  assert.doesNotMatch(built.filterGraph, /output_scaled/);
  assert.doesNotMatch(built.filterGraph, /output_fps/);
});
