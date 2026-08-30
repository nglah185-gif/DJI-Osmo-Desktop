const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createOfficialLutRegistry } = require("../src/color/lut-registry");
const { action4DlogGraph } = require("../src/color/pipeline");
const { createEffectGraph } = require("../src/color/effect-graph");
const { FfmpegFrameRenderer } = require("../src/renderers/ffmpeg-frame-renderer");
const { compareRgbBuffers, psnr } = require("../src/color/metrics");

const WIDTH = 1280;
const HEIGHT = 720;
const TIMESTAMPS = [0.5, 1.0, 1.5];
const PAIRS = [
  { id: "dlog-named", label: "d log 10bit (unconfirmed mode)", original: "d log 10bit.MP4", lrf: "d log 10bit.LRF" },
  { id: "normal-named", label: "normal color (research control)", original: "普通色彩.MP4", lrf: "普通色彩.LRF" }
];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = []; const err = [];
    child.stdout.on("data", chunk => out.push(chunk)); child.stderr.on("data", chunk => err.push(chunk));
    child.on("error", reject); child.on("close", code => resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err).toString() }));
  });
}
async function pngToRgb(filePath) {
  const result = await run(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-i", filePath, "-vf", "format=rgb24", "-frames:v", "1", "-f", "rawvideo", "pipe:1"]);
  if (result.code !== 0) throw new Error(result.err);
  return result.out;
}
async function quality(leftPath, rightPath) {
  const result = await run(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "info", "-i", leftPath, "-i", rightPath, "-lavfi", "[0:v][1:v]ssim;[0:v][1:v]psnr", "-f", "null", "-"]);
  if (result.code !== 0) throw new Error(result.err);
  const ssim = result.err.match(/All:([0-9.]+)/); const psnrAverage = result.err.match(/average:([0-9.]+)/);
  return { ssim: ssim ? Number(ssim[1]) : null, psnrFfmpeg: psnrAverage ? Number(psnrAverage) : null };
}
function histogramDifference(left, right) {
  let distance = 0;
  for (let channel = 0; channel < 3; channel++) {
    const a = new Uint32Array(256); const b = new Uint32Array(256);
    for (let i = channel; i < left.length; i += 3) { a[left[i]]++; b[right[i]]++; }
    for (let value = 0; value < 256; value++) distance += Math.abs(a[value] - b[value]);
  }
  return distance / (left.length / 3 * 3);
}
async function differenceImage(leftPath, rightPath, outputPath) {
  const result = await run(process.env.FFMPEG_PATH || "ffmpeg", ["-y", "-v", "error", "-i", leftPath, "-i", rightPath, "-filter_complex", "[0:v][1:v]blend=all_mode=difference,format=rgb24", "-frames:v", "1", outputPath]);
  if (result.code !== 0) throw new Error(result.err);
}
function summarize(metrics) { return { mae: metrics.mae, rmse: metrics.rmse, psnr: psnr(metrics.left, metrics.right), maxChannelError: metrics.maxChannelError, histogramL1Normalized: histogramDifference(metrics.left, metrics.right) }; }
function format(value, digits = 4) { return Number.isFinite(value) ? value.toFixed(digits) : "N/A"; }

(async () => {
  const root = path.resolve(__dirname, "..", ".."); const project = path.resolve(__dirname, ".."); const mediaRoot = path.join(root, "dji-test-media"); const outputRoot = path.join(project, "artifacts", "lrf-original-lut-input-analysis");
  await fs.mkdir(outputRoot, { recursive: true });
  const registry = createOfficialLutRegistry(root); const renderer = new FfmpegFrameRenderer({ cacheRoot: path.join(project, "artifacts", "generated-luts") }); const rawGraph = createEffectGraph(); const officialCubeGraph = action4DlogGraph(); const results = [];
  for (const pair of PAIRS) for (const timestamp of TIMESTAMPS) {
    const stem = pair.id + "-t" + timestamp.toFixed(3).replace(".", "_"); const originalPath = path.join(mediaRoot, pair.original); const lrfPath = path.join(mediaRoot, pair.lrf);
    const rendered = {};
    for (const [key, inputPath, graph] of [["A-original-raw", originalPath, rawGraph], ["B-lrf-raw", lrfPath, rawGraph], ["C-original-official-cube", originalPath, officialCubeGraph], ["D-lrf-official-cube", lrfPath, officialCubeGraph]]) {
      const frame = await renderer.render({ inputPath, timestampSeconds: timestamp, graph, lutRegistry: registry, styleRegistry: null, width: WIDTH, height: HEIGHT }); const outputPath = path.join(outputRoot, stem + "-" + key + ".png"); await fs.writeFile(outputPath, frame.png); rendered[key] = { outputPath, rgb: await pngToRgb(outputPath), filterGraph: frame.filterGraph };
    }
    const ab = compareRgbBuffers(rendered["A-original-raw"].rgb, rendered["B-lrf-raw"].rgb); ab.left = rendered["A-original-raw"].rgb; ab.right = rendered["B-lrf-raw"].rgb;
    const cd = compareRgbBuffers(rendered["C-original-official-cube"].rgb, rendered["D-lrf-official-cube"].rgb); cd.left = rendered["C-original-official-cube"].rgb; cd.right = rendered["D-lrf-official-cube"].rgb;
    const abMetrics = { ...summarize(ab), ...(await quality(rendered["A-original-raw"].outputPath, rendered["B-lrf-raw"].outputPath)) };
    const cdMetrics = { ...summarize(cd), ...(await quality(rendered["C-original-official-cube"].outputPath, rendered["D-lrf-official-cube"].outputPath)) };
    const abDiff = path.join(outputRoot, stem + "-A_vs_B.png"); const cdDiff = path.join(outputRoot, stem + "-C_vs_D.png"); await differenceImage(rendered["A-original-raw"].outputPath, rendered["B-lrf-raw"].outputPath, abDiff); await differenceImage(rendered["C-original-official-cube"].outputPath, rendered["D-lrf-official-cube"].outputPath, cdDiff);
    results.push({ pair, timestamp, ab: abMetrics, cd: cdMetrics, rmseAmplification: cdMetrics.rmse / abMetrics.rmse, maeAmplification: cdMetrics.mae / abMetrics.mae, ssimDelta: cdMetrics.ssim - abMetrics.ssim, outputRoot, abDiff, cdDiff, graphShared: rendered["C-original-official-cube"].filterGraph === rendered["D-lrf-official-cube"].filterGraph });
  }
  const lines = ["# LRF_ORIGINAL_LUT_INPUT_ANALYSIS_V2.md", "", "## Scope", "", "This experiment studies how the same official Action 4 D-Log M to Rec.709 CUBE behaves on an Original MP4 and its LRF proxy. It does not assert that either named sample was recorded in D-Log M. The normal-color pair is a control for proxy/source behavior, not a correctness test for a D-Log M transform.", "", "## Method", "", "- Timestamps: 00:00.500, 00:01.000, 00:01.500.", "- A: Original MP4, no LUT; B: LRF, no LUT; C: Original MP4 plus official Action 4 CUBE; D: LRF plus the same official CUBE.", "- Every output is 1280x720 RGB24 PNG. Original is downscaled with FFmpeg after decode; LRF remains decoded at its native 1280x720. No range, gamma, or chroma compensation was added.", "- Difference images use absolute RGB difference: A_vs_B.png and C_vs_D.png.", "- FFmpeg decoder metadata on both sources is limited-range BT.709 matrix, primaries, and transfer. Original is yuv420p10le HEVC at 59.94 fps; LRF is yuv420p H.264 at 29.97 fps; both signal left chroma siting. The shared metadata does not prove identical decoded RGB or prove D-Log M.", "", "## Results", "", "| Pair / timestamp | A/B MAE | A/B RMSE | A/B PSNR | A/B SSIM | A/B hist L1 | C/D MAE | C/D RMSE | C/D PSNR | C/D SSIM | C/D hist L1 | Max C/D | RMSE multiplier |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
  for (const row of results) lines.push("| " + row.pair.id + " / " + row.timestamp.toFixed(3) + " | " + format(row.ab.mae) + " | " + format(row.ab.rmse) + " | " + format(row.ab.psnr) + " | " + format(row.ab.ssim) + " | " + format(row.ab.histogramL1Normalized, 6) + " | " + format(row.cd.mae) + " | " + format(row.cd.rmse) + " | " + format(row.cd.psnr) + " | " + format(row.cd.ssim) + " | " + format(row.cd.histogramL1Normalized, 6) + " | " + format(row.cd.maxChannelError, 0) + " | " + format(row.rmseAmplification, 3) + " |" );
  const dlogRows = results.filter(row => row.pair.id === "dlog-named"); const avg = property => dlogRows.reduce((sum, row) => sum + property(row), 0) / dlogRows.length; const rmseMultiplier = avg(row => row.rmseAmplification); const ssimDelta = avg(row => row.ssimDelta); const recommendation = rmseMultiplier > 1.25 || ssimDelta < -0.01 ? "NOT RECOMMENDED" : rmseMultiplier <= 1.10 && ssimDelta >= -0.003 ? "RECOMMENDED" : "PLAUSIBLE";
  lines.push("", "## Difference amplification", "", "For the unconfirmed D-Log-named pair, mean C/D-to-A/B RMSE multiplier is " + format(rmseMultiplier, 3) + " and mean SSIM change is " + format(ssimDelta, 5) + ". A multiplier above 1 means the CUBE increases the proxy/original difference; it does not establish a color-management bug by itself.", "", "## Input-domain interpretation", "", "- No obvious metadata-level range or matrix mismatch exists: all four sources signal MPEG/TV range with BT.709 matrix, primaries, and transfer; both LRF files retain left chroma siting.", "- There is nevertheless an unavoidable representation mismatch: Original is decoded from 10-bit 4:2:0 HEVC at 59.94 fps, while LRF is decoded from 8-bit 4:2:0 H.264 at 29.97 fps. Scale, temporal sampling, quantization, and codec decisions therefore remain sources of pre-LUT pixel difference.", "- No ungrounded range or gamma adjustment was attempted. Such compensation would change the stated input semantics and could hide, rather than explain, the proxy divergence.", "", "## Decision", "", "**" + recommendation + "**: LRF -> official CUBE -> Preview for color-critical editing.", "", "The decision follows the measured C/D versus A/B behavior above. For ordinary browsing, LRF remains appropriate. If the decision is not RECOMMENDED, choose **Option B**: ordinary browsing uses LRF; color adjustment and LUT preview uses Original decode -> downscale -> official CUBE. Option C is reserved for a future decision when the measured need outweighs its performance cost.", "", "## Artifacts", "", "All four baseline PNGs and A/B and C/D difference PNGs are in `artifacts/lrf-original-lut-input-analysis/`.", "");
  const reportPath = path.join(project, "LRF_ORIGINAL_LUT_INPUT_ANALYSIS_V2.md"); await fs.writeFile(reportPath, lines.join("\n"), "utf8"); console.log(JSON.stringify({ reportPath, recommendation, results }, null, 2));
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
