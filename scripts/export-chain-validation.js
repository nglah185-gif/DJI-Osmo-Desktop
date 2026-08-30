"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ColorRenderService } = require("../src/renderers/color-render-service");
const { createOfficialLutRegistry } = require("../src/color/lut-registry");
const { createWatermarkRegistry } = require("../src/watermark/watermark-registry");
const { createEffectGraph } = require("../src/color/effect-graph");
const { action4DlogGraph } = require("../src/color/pipeline");

const projectRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(projectRoot, "..");
const inputPath = path.join(workspaceRoot, "dji-test-media", "d log 10bit.MP4");
const outputDir = path.join(projectRoot, "artifacts", "export-chain-validation");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() }));
  });
}

async function validate(outputPath) {
  const probe = await run(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "format=duration,size:stream=codec_type,codec_name,width,height", "-of", "json", outputPath]);
  if (probe.code !== 0) throw new Error("ffprobe failed: " + probe.stderr);
  const decode = await run(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-i", outputPath, "-map", "0:v:0", "-f", "null", "-"]);
  if (decode.code !== 0) throw new Error("decode failed: " + decode.stderr);
  const parsed = JSON.parse(probe.stdout.toString());
  return {
    duration: Number(parsed.format.duration),
    size: Number(parsed.format.size),
    video: parsed.streams.find(stream => stream.codec_type === "video"),
    audio: parsed.streams.find(stream => stream.codec_type === "audio") || null,
    decodable: true
  };
}

(async () => {
  await fs.mkdir(outputDir, { recursive: true });
  const lutRegistry = createOfficialLutRegistry(workspaceRoot);
  const watermark = createWatermarkRegistry(workspaceRoot).get("action4.official.oa4");
  const service = new ColorRenderService({ root: workspaceRoot, lutRegistry, styleRegistry: null });
  const overlay = { kind: "image", path: watermark.path, resourceId: watermark.id, sha256: watermark.sha256, position: "bottomRight", scale: 0.25, opacity: 0.8, enabled: true };
  const cases = [
    ["original", createEffectGraph()],
    ["dlog", action4DlogGraph()],
    ["creative", action4DlogGraph("action4.creative.forest-pro")],
    ["watermark", createEffectGraph({ overlays: [overlay] })],
    ["combined", createEffectGraph({ ...action4DlogGraph("action4.creative.ice-pro"), overlays: [overlay] })]
  ];
  const clip = { sourceInUs: 100000, sourceOutUs: 700000, playbackRate: 1, volume: 1, muted: false };
  const results = [];
  for (const [name, graph] of cases) {
    const outputPath = path.join(outputDir, name + ".mp4");
    const rendered = await service.exportOriginal(inputPath, outputPath, graph, null, null, clip);
    results.push({ name, outputPath, elapsedMs: rendered.elapsedMs, ...(await validate(outputPath)) });
  }
  const report = { inputPath, clip, generatedAt: new Date().toISOString(), results };
  await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
