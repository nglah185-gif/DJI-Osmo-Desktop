const fs = require("node:fs/promises");

async function parseCube(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return parseCubeText(text, filePath);
}
function parseCubeText(text, source = "UNKNOWN") {
  let title = null; let size = null; let domainMin = [0, 0, 0]; let domainMax = [1, 1, 1]; const values = []; const comments = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim(); if (!line) continue;
    if (line.startsWith("#")) { comments.push(line.slice(1).trim()); continue; }
    const parts = line.split(/\s+/); const keyword = parts[0].toUpperCase();
    if (keyword === "TITLE") { title = line.slice(parts[0].length).trim().replace(/^"|"$/g, ""); continue; }
    if (keyword === "LUT_3D_SIZE") { size = Number(parts[1]); continue; }
    if (keyword === "DOMAIN_MIN") { domainMin = parts.slice(1, 4).map(Number); continue; }
    if (keyword === "DOMAIN_MAX") { domainMax = parts.slice(1, 4).map(Number); continue; }
    if (parts.length >= 3 && parts.slice(0, 3).every(item => Number.isFinite(Number(item)))) values.push(parts.slice(0, 3).map(Number));
  }
  if (!Number.isInteger(size) || size < 2) throw new Error("CUBE missing valid LUT_3D_SIZE: " + source);
  if (values.length !== size ** 3) throw new Error("CUBE sample count mismatch: expected " + (size ** 3) + ", got " + values.length);
  if (![...domainMin, ...domainMax].every(Number.isFinite)) throw new Error("CUBE has invalid domain: " + source);
  // An empty domain divides by zero in sampleCube, which turns every sample into
  // NaN and then writes NaN bytes into the frame. Reject the file instead.
  for (let channel = 0; channel < 3; channel++) if (!(domainMax[channel] > domainMin[channel])) throw new Error("CUBE has an empty domain on channel " + channel + ": " + source);
  return { format: "CUBE", title, size, domainMin, domainMax, values, comments, source };
}
function sampleCube(lut, rgb) {
  const n = lut.size; const p = rgb.map((value, i) => clamp((value - lut.domainMin[i]) / (lut.domainMax[i] - lut.domainMin[i]), 0, 1) * (n - 1));
  const i0 = p.map(Math.floor); const i1 = p.map(value => Math.min(n - 1, Math.ceil(value))); const f = p.map((value, i) => value - i0[i]);
  const out = [0, 0, 0];
  for (let b = 0; b <= 1; b++) for (let g = 0; g <= 1; g++) for (let r = 0; r <= 1; r++) { const weight = (b ? f[2] : 1 - f[2]) * (g ? f[1] : 1 - f[1]) * (r ? f[0] : 1 - f[0]); const index = ((b ? i1[2] : i0[2]) * n + (g ? i1[1] : i0[1])) * n + (r ? i1[0] : i0[0]); const value = lut.values[index]; for (let c = 0; c < 3; c++) out[c] += value[c] * weight; }
  return out;
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
module.exports = { parseCube, parseCubeText, sampleCube, clamp };
