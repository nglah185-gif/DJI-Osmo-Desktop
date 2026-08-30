const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { action4DlogGraph } = require("../src/color/pipeline");
const { createOfficialLutRegistry } = require("../src/color/lut-registry");
const { createStyleRegistry } = require("../src/color/style-registry");
const { FfmpegFrameRenderer } = require("../src/renderers/ffmpeg-frame-renderer");
const { compareRgbBuffers, psnr } = require("../src/color/metrics");

function run(command, args) { return new Promise((resolve, reject) => { const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); const out = []; const err = []; child.stdout.on("data", chunk => out.push(chunk)); child.stderr.on("data", chunk => err.push(chunk)); child.on("error", reject); child.on("close", code => resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err).toString() })); }); }
async function pngRgb(filePath) { const result = await run(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-i", filePath, "-vf", "format=rgb24", "-frames:v", "1", "-f", "rawvideo", "pipe:1"]); if (result.code !== 0) throw new Error(result.err); return result.out; }
function metric(a, b) { const result = compareRgbBuffers(a, b); return { ...result, psnr: psnr(a, b) }; }

(async () => {
  const original = process.env.ACTION4_DLOGM_ORIGINAL;
  const lrf = process.env.ACTION4_DLOGM_LRF;
  if (!original || !lrf) throw new Error("Set ACTION4_DLOGM_ORIGINAL and ACTION4_DLOGM_LRF to an explicitly confirmed Action 4 D-Log M pair. Filenames and ffprobe metadata are not confirmation.");
  const root = path.resolve(__dirname, "..", ".."); const project = path.resolve(__dirname, ".."); const outputDir = path.join(project, "artifacts", "original-lrf-experiment"); await fs.mkdir(outputDir, { recursive: true });
  const renderer = new FfmpegFrameRenderer({ cacheRoot: path.join(project, "artifacts", "generated-luts") }); const registry = createOfficialLutRegistry(root); const styles = createStyleRegistry(root); const graph = action4DlogGraph(); const timestamp = Number(process.env.ACTION4_EXPERIMENT_TIMESTAMP || 0.5);
  const rawGraph = require("../src/color/effect-graph").createEffectGraph();
  const cases = [["original-raw", original, rawGraph], ["lrf-raw", lrf, rawGraph], ["original-official-cube", original, graph], ["lrf-official-cube", lrf, graph]];
  const outputs = {};
  for (const [name, inputPath, itemGraph] of cases) { const rendered = await renderer.render({ inputPath, timestampSeconds: timestamp, graph: itemGraph, lutRegistry: registry, styleRegistry: styles, width: 1280, height: 720 }); const outputPath = path.join(outputDir, name + ".png"); await fs.writeFile(outputPath, rendered.png); outputs[name] = { path: outputPath, rgb: await pngRgb(outputPath), filterGraph: rendered.filterGraph }; }
  const rows = [["Original vs LRF, no LUT", metric(outputs["original-raw"].rgb, outputs["lrf-raw"].rgb)], ["Original vs LRF, official CUBE", metric(outputs["original-official-cube"].rgb, outputs["lrf-official-cube"].rgb)], ["Original raw vs official CUBE", metric(outputs["original-raw"].rgb, outputs["original-official-cube"].rgb)], ["LRF raw vs official CUBE", metric(outputs["lrf-raw"].rgb, outputs["lrf-official-cube"].rgb)]];
  const lines = ["# ACTION4_ORIGINAL_LRF_LUT_EXPERIMENT_V2.md", "", "## Inputs", "", "- Confirmation: user supplied ACTION4_DLOGM_ORIGINAL and ACTION4_DLOGM_LRF as a confirmed Action 4 D-Log M pair.", "- Timestamp: " + timestamp.toFixed(3) + " seconds.", "- Technical transform: action4.dlogm.rec709.website-cube (official DJI website CUBE).", "", "## Numeric comparison", "", "| Comparison | MAE | RMSE | Max channel error | PSNR |", "|---|---:|---:|---:|---:|"];
  for (const [name, value] of rows) lines.push("| " + name + " | " + value.mae.toFixed(4) + " | " + value.rmse.toFixed(4) + " | " + value.maxChannelError + " | " + value.psnr.toFixed(4) + " dB |");
  lines.push("", "## Interpretation", "", "Original and LRF are evaluated without source substitution. Differences before or after the CUBE are evidence about the LRF proxy input; they do not authorize hidden compensation. Review black levels, highlights, saturation and fine detail in the four PNG artifacts before deciding whether Preview should decode Original and downscale.", "", "Artifacts: artifacts/original-lrf-experiment/.", "");
  await fs.writeFile(path.join(project, "ACTION4_ORIGINAL_LRF_LUT_EXPERIMENT_V2.md"), lines.join("\n"), "utf8"); console.log(JSON.stringify({ report: path.join(project, "ACTION4_ORIGINAL_LRF_LUT_EXPERIMENT_V2.md"), outputs: Object.fromEntries(Object.entries(outputs).map(([name, value]) => [name, value.path])) }, null, 2));
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
