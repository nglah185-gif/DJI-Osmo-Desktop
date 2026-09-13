const { sampleLut } = require("./hald-lut");

// Bytes written to a Buffer wrap modulo 256, so a LUT that returns a value
// slightly outside 0..255 (or a strength outside 0..1) produced a violently
// wrong pixel -- 260 became 4 -- while the preview path, which uses
// Uint8ClampedArray, clamped and looked correct. Clamp here so preview and
// export cannot disagree.
function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }

function applyLutToRgbFrame(frame, lut, strength = 1) {
  const output = Buffer.from(frame);
  for (let i = 0; i < frame.length; i += 3) {
    const mapped = sampleLut(lut, [frame[i] / 255, frame[i + 1] / 255, frame[i + 2] / 255]);
    output[i] = clampByte((frame[i] / 255 * (1 - strength) + mapped[0] * strength) * 255);
    output[i + 1] = clampByte((frame[i + 1] / 255 * (1 - strength) + mapped[1] * strength) * 255);
    output[i + 2] = clampByte((frame[i + 2] / 255 * (1 - strength) + mapped[2] * strength) * 255);
  }
  return output;
}
function frameStats(elapsedMs, frameBytes, width, height) { return { elapsedMs, width, height, frameBytes, fps: elapsedMs > 0 ? 1000 / elapsedMs : 0, cpu: "PROCESS_CPU_NOT_MEASURED", memory: "PROCESS_MEMORY_NOT_MEASURED" }; }
module.exports = { applyLutToRgbFrame, frameStats, clampByte };
