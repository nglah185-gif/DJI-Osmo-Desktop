const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createOfficialLutRegistry } = require("../src/color/lut-registry");
const { decodeRgbImage, decodeHaldImage, sampleLut } = require("../src/color/hald-lut");
const { parseCube, sampleCube } = require("../src/color/cube-lut");
const { compareRgbBuffers, psnr } = require("../src/color/metrics");
const { applyLutToRgbFrame } = require("../src/color/lut-engine");

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    if (input) child.stdin.end(input);
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() }));
  });
}
async function frame(filePath, width, height, timestamp) {
  const result = await run(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-ss", String(timestamp), "-i", filePath, "-vf", "scale=" + width + ":" + height + ",format=rgb24", "-frames:v", "1", "-f", "rawvideo", "pipe:1"]);
  if (result.code !== 0) throw new Error(result.stderr);
  return { width, height, data: result.stdout };
}
async function writePng(rgb, width, height, outputPath) {
  const result = await run(process.env.FFMPEG_PATH || "ffmpeg", ["-y", "-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", width + "x" + height, "-framerate", "1", "-i", "pipe:0", "-frames:v", "1", outputPath], rgb);
  if (result.code !== 0) throw new Error(result.stderr);
}
function grid(size) { const values = []; for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) values.push([r / (size - 1), g / (size - 1), b / (size - 1)]); return values; }
function compareLuts(hald, cube, inputs) { let sum = 0; let squared = 0; let max = 0; let within = 0; const channels = inputs.length * 3; for (const input of inputs) { const a = sampleLut(hald, input); const b = sampleCube(cube, input); for (let c = 0; c < 3; c++) { const error = Math.abs(a[c] - b[c]); sum += error; squared += error * error; max = Math.max(max, error); if (error <= 1 / 255) within++; } } return { samples: inputs.length, channels, mae: sum / channels, rmse: Math.sqrt(squared / channels), maxChannelError: max, percentWithinTolerance1of255: within / channels * 100 }; }
function fmt(value) { return Number.isFinite(value) ? value.toFixed(6) : "Infinity"; }

(async () => {
  const root = path.resolve(__dirname, "..", "..");
  const registry = createOfficialLutRegistry(root);
  const haldEntry = registry.get("action4.dlogm.rec709.apk-hald");
  const cubeEntry = registry.get("action4.dlogm.rec709.website-cube");
  const hald = decodeHaldImage(await decodeRgbImage(haldEntry.path), { source: haldEntry.sha256 });
  const cube = await parseCube(cubeEntry.path);
  const gridMetrics = compareLuts(hald, cube, grid(33));
  const fixture = path.join(root, "dji-test-media");
  const lrf = await frame(path.join(fixture, "d log 10bit.LRF"), 1280, 720, 0.5);
  const original = await frame(path.join(fixture, "d log 10bit.MP4"), 1280, 720, 0.5);
  const haldLrf = applyLutToRgbFrame(lrf.data, hald, 1);
  const cubeLrf = applyLutToRgbFrame(lrf.data, cube, 1);
  const haldOriginal = applyLutToRgbFrame(original.data, hald, 1);
  const cubeOriginal = applyLutToRgbFrame(original.data, cube, 1);
  const visualLrf = compareRgbBuffers(haldLrf, cubeLrf);
  const visualOriginal = compareRgbBuffers(haldOriginal, cubeOriginal);
  const proxyOriginal = compareRgbBuffers(haldLrf, haldOriginal);
  const artifactDir = path.join(__dirname, "..", "artifacts", "lut-equivalence");
  await fs.mkdir(artifactDir, { recursive: true });
  await writePng(haldLrf, lrf.width, lrf.height, path.join(artifactDir, "action4-lrf-hald.png"));
  await writePng(cubeLrf, lrf.width, lrf.height, path.join(artifactDir, "action4-lrf-cube.png"));
  await writePng(haldOriginal, original.width, original.height, path.join(artifactDir, "action4-original-hald.png"));
  await writePng(cubeOriginal, original.width, original.height, path.join(artifactDir, "action4-original-cube.png"));
  const classification = gridMetrics.rmse <= 0.002 && gridMetrics.maxChannelError <= 0.01 ? "EQUIVALENT" : gridMetrics.rmse <= 0.01 && gridMetrics.maxChannelError <= 0.05 ? "CLOSE" : "DIFFERENT";
  const lines = [];
  lines.push("# LUT_EQUIVALENCE_V2.md", "", "## Scope", "", "This is a historical research comparison only. The APK Hald is RESEARCH_ONLY and is not eligible for V2 preview, export, default, or automatic technical transforms.", "", "## Compared resources", "");
  lines.push("- APK Hald: " + haldEntry.path, "- APK SHA-256: " + haldEntry.sha256, "- Website CUBE: " + cubeEntry.path, "- Website SHA-256: " + cubeEntry.sha256, "- Hald: 512x512 standard Hald, decoded as 64^3", "- CUBE: LUT_3D_SIZE " + cube.size, "- Unified input grid: 33^3 = " + gridMetrics.samples + " RGB points", "", "## Classification", "", "**" + classification + "**", "", "Classification uses numeric samples and not filenames. Both resources remain separately registered.", "", "## Numeric comparison", "", "| Metric | Result |", "|---|---:|", "| MAE, normalized RGB | " + fmt(gridMetrics.mae) + " |", "| RMSE, normalized RGB | " + fmt(gridMetrics.rmse) + " |", "| Max channel error | " + fmt(gridMetrics.maxChannelError) + " |", "| Percent within 1/255 | " + fmt(gridMetrics.percentWithinTolerance1of255) + "% |", "", "## Visual frame comparison", "", "Timestamp: 00:00.500. Original was scaled to 1280x720. Both paths used the same CPU trilinear sampler.", "", "| Comparison | MAE | RMSE | Max error | PSNR |", "|---|---:|---:|---:|---:|", "| LRF Hald vs LRF CUBE | " + fmt(visualLrf.mae) + " | " + fmt(visualLrf.rmse) + " | " + fmt(visualLrf.maxChannelError) + " | " + fmt(psnr(haldLrf, cubeLrf)) + " dB |", "| Original Hald vs Original CUBE | " + fmt(visualOriginal.mae) + " | " + fmt(visualOriginal.rmse) + " | " + fmt(visualOriginal.maxChannelError) + " | " + fmt(psnr(haldOriginal, cubeOriginal)) + " dB |", "| LRF Hald vs Original Hald | " + fmt(proxyOriginal.mae) + " | " + fmt(proxyOriginal.rmse) + " | " + fmt(proxyOriginal.maxChannelError) + " | " + fmt(psnr(haldLrf, haldOriginal)) + " dB |", "", "## Artifacts", "", "- artifacts/lut-equivalence/action4-lrf-hald.png", "- artifacts/lut-equivalence/action4-lrf-cube.png", "- artifacts/lut-equivalence/action4-original-hald.png", "- artifacts/lut-equivalence/action4-original-cube.png", "", "## Interpretation", "", "The official website CUBE is the V2 Action 4 technical transform. The APK Hald remains only for research comparison. No source substitution is performed.", "");
  const reportPath = path.join(__dirname, "..", "LUT_EQUIVALENCE_V2.md");
  await fs.writeFile(reportPath, lines.join("\n"), "utf8");
  console.log(JSON.stringify({ classification, gridMetrics, visualLrf, visualOriginal, proxyOriginal, reportPath, artifactDir }, null, 2));
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
