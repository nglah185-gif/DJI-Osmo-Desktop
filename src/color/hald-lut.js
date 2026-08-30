const { spawn } = require("node:child_process");
const { clamp } = require("./cube-lut");

async function decodeRgbImage(filePath, options = {}) {
  const ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
  const probe = await run(ffmpegPath, ["-v", "error", "-i", filePath, "-f", "rawvideo", "-pix_fmt", "rgb24", "-frames:v", "1", "pipe:1"]);
  if (probe.code !== 0) throw new Error("Unable to decode RGB image: " + probe.stderr);
  const dimensions = await imageDimensions(filePath, options);
  return { width: dimensions.width, height: dimensions.height, data: probe.stdout };
}
async function imageDimensions(filePath, options = {}) {
  const ffprobePath = options.ffprobePath || process.env.FFPROBE_PATH || "ffprobe";
  const result = await run(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", filePath]);
  if (result.code !== 0) throw new Error("Unable to inspect image dimensions: " + result.stderr);
  const [width, height] = result.stdout.toString().trim().split("x").map(Number);
  if (!width || !height) throw new Error("Invalid image dimensions: " + filePath);
  return { width, height };
}
function run(command, args) { return new Promise((resolve, reject) => { const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); const stdout = []; const stderr = []; child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk)); child.on("error", reject); child.on("close", code => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() })); }); }

function decodeHaldImage(image, options = {}) {
  const level = Math.round(Math.cbrt(image.width));
  if (image.width !== image.height || level ** 3 !== image.width) throw new Error("Image is not a standard square Hald CLUT: " + image.width + "x" + image.height);
  const cubeSize = level * level; const values = new Array(cubeSize ** 3); const { data } = image;
  for (let b = 0; b < cubeSize; b++) for (let g = 0; g < cubeSize; g++) for (let r = 0; r < cubeSize; r++) {
    const x = (r % level) + (g % level) * level + (b % level) * level * level;
    const y = Math.floor(r / level) + Math.floor(g / level) * level + Math.floor(b / level) * level * level;
    const offset = (y * image.width + x) * 3; const index = (b * cubeSize + g) * cubeSize + r;
    values[index] = [data[offset] / 255, data[offset + 1] / 255, data[offset + 2] / 255];
  }
  return { format: "HALD", level, size: cubeSize, values, source: options.source || "UNKNOWN" };
}
function sampleLut(lut, rgb) { const n = lut.size; const p = rgb.map(value => clamp(value, 0, 1) * (n - 1)); const i0 = p.map(Math.floor); const i1 = p.map(value => Math.min(n - 1, Math.ceil(value))); const f = p.map((value, i) => value - i0[i]); const out = [0, 0, 0]; for (let b = 0; b <= 1; b++) for (let g = 0; g <= 1; g++) for (let r = 0; r <= 1; r++) { const weight = (b ? f[2] : 1 - f[2]) * (g ? f[1] : 1 - f[1]) * (r ? f[0] : 1 - f[0]); const index = ((b ? i1[2] : i0[2]) * n + (g ? i1[1] : i0[1])) * n + (r ? i1[0] : i0[0]); const value = lut.values[index]; for (let c = 0; c < 3; c++) out[c] += value[c] * weight; } return out; }
module.exports = { decodeRgbImage, imageDimensions, decodeHaldImage, sampleLut };
