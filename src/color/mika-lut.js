const { sampleLut, clamp } = require("./hald-lut");

function decodeMikaAtlas(image, options = {}) {
  const tileSize = options.tileSize || 128; const columns = options.columns || 16; const rows = options.rows || 8;
  if (image.width !== tileSize * columns || image.height !== tileSize * rows) throw new Error("Unexpected MIKA atlas dimensions: " + image.width + "x" + image.height);
  const size = tileSize; const values = new Array(size ** 3); const data = image.data;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const tileX = b % columns; const tileY = Math.floor(b / columns); const x = tileX * tileSize + r; const y = tileY * tileSize + g; const offset = (y * image.width + x) * 3; const index = (b * size + g) * size + r;
    values[index] = [data[offset] / 255, data[offset + 1] / 255, data[offset + 2] / 255];
  }
  return { format: "MIKA_ATLAS_128", size, tileSize, columns, rows, values, source: options.source || "UNKNOWN" };
}
function resampleLut(source, size) { const values = new Array(size ** 3); for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) values[(b * size + g) * size + r] = sampleLut(source, [r / (size - 1), g / (size - 1), b / (size - 1)]); return { format: "3D_LUT", size, values, source: source.source, derivedFrom: source.format }; }
function applyMikaToFrame(frame, lut, strength = 1) { const output = new Uint8ClampedArray(frame.length); for (let i = 0; i < frame.length; i += 4) { const mapped = sampleLut(lut, [frame[i] / 255, frame[i + 1] / 255, frame[i + 2] / 255]); output[i] = Math.round((frame[i] / 255 * (1 - strength) + mapped[0] * strength) * 255); output[i + 1] = Math.round((frame[i + 1] / 255 * (1 - strength) + mapped[1] * strength) * 255); output[i + 2] = Math.round((frame[i + 2] / 255 * (1 - strength) + mapped[2] * strength) * 255); output[i + 3] = frame[i + 3]; } return output; }
module.exports = { decodeMikaAtlas, resampleLut, applyMikaToFrame };
