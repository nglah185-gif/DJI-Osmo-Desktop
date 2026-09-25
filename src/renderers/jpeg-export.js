"use strict";

// Still-photo export, shared by the batch dialog and the unattended card script
// so both produce identical bytes.
//
// A photo carries no colour pipeline: it is one watermark overlay and one JPEG
// encode, or -- when no watermark was asked for -- a plain copy. Either way the
// camera's EXIF and the capture time are carried across, because a JPEG that
// lost its capture date is much harder to find again later.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { inkOverlayFilters, INK_CENTER_Y_RATIO, INK_WIDTH_RATIO } = require("../watermark/watermark-position");

// ffmpeg's mjpeg output carries no EXIF. The source's APP1/APP2/APP13 segments
// (EXIF, ICC, Photoshop) are copied into the finished file byte for byte, after
// the JFIF header, which is where readers expect them.
function copyJpegMetadata(sourcePath, targetPath) {
  const source = fs.readFileSync(sourcePath);
  const target = fs.readFileSync(targetPath);
  const carried = [];
  let offset = 2;
  while (offset + 4 <= source.length && source[offset] === 0xff) {
    const marker = source[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = source.readUInt16BE(offset + 2);
    if (length < 2) break;
    const end = offset + 2 + length;
    if (end > source.length) break;
    if (marker === 0xe1 || marker === 0xe2 || marker === 0xed) carried.push(source.subarray(offset, end));
    offset = end;
  }
  if (!carried.length) return false;

  const app0 = [];
  const rest = [];
  offset = 2;
  while (offset + 4 <= target.length && target[offset] === 0xff) {
    const marker = target[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = target.readUInt16BE(offset + 2);
    if (length < 2) break;
    const end = offset + 2 + length;
    if (end > target.length) break;
    const segment = target.subarray(offset, end);
    if (marker === 0xe0 && !app0.length) app0.push(segment);
    else if (marker !== 0xe1 && marker !== 0xe2 && marker !== 0xed) rest.push(segment);
    offset = end;
  }
  const header = Buffer.concat([target.subarray(0, 2), ...app0, ...carried, ...rest]);
  fs.writeFileSync(targetPath, Buffer.concat([header, target.subarray(offset)]));
  return true;
}

// DateTimeOriginal from the Exif sub-IFD. Written out rather than pulled from a
// dependency: this is the only tag needed and it keeps the package to ffmpeg.
function exifCaptureTime(file) {
  let buffer;
  try { buffer = fs.readFileSync(file); } catch { return null; }
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    const end = offset + 2 + length;
    if (end > buffer.length) break;
    if (marker === 0xe1 && buffer.toString("latin1", offset + 4, offset + 10) === "Exif\0\0") {
      const tiff = buffer.subarray(offset + 10, end);
      const little = tiff[0] === 0x49;
      const read16 = o => little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o);
      const read32 = o => little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o);
      if (tiff.length < 8 || read16(2) !== 0x002a) return null;
      const ifd0 = read32(4);
      if (ifd0 + 2 > tiff.length) return null;
      let exifIfd = 0;
      const count = read16(ifd0);
      for (let index = 0; index < count; index++) {
        const entry = ifd0 + 2 + index * 12;
        if (entry + 12 > tiff.length) break;
        if (read16(entry) === 0x8769) exifIfd = read32(entry + 8);
      }
      if (!exifIfd) return null;
      const exifCount = read16(exifIfd);
      for (let index = 0; index < exifCount; index++) {
        const entry = exifIfd + 2 + index * 12;
        if (entry + 12 > tiff.length) break;
        if (read16(entry) === 0x9003) {
          const size = read32(entry + 4);
          const value = read32(entry + 8);
          if (size <= 0 || value + size > tiff.length) return null;
          return tiff.toString("latin1", value, value + size).replace(/\0+$/, "");
        }
      }
      return null;
    }
    offset = end;
  }
  return null;
}

function parseStampParts(match) {
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (year < 1980 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(year, month - 1, day, hour, minute, second);
}
function parseExifStamp(text) { return parseStampParts(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(String(text || ""))); }
function parseNameStamp(text) { return parseStampParts(/(\d{4})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/.exec(String(text || ""))); }

// The capture time a file should carry: the photo's own EXIF first, then the DJI
// file name both media kinds encode it in, then the source's modification time.
function captureTimeFor(sourcePath, fileName = null) {
  const fromExif = parseExifStamp(exifCaptureTime(sourcePath));
  if (fromExif) return fromExif;
  const fromName = parseNameStamp(fileName || path.basename(sourcePath));
  if (fromName) return fromName;
  try { return fs.statSync(sourcePath).mtime; } catch { return null; }
}

// Explorer's date column is the file's modification time, so a freshly written
// export would look like it was taken today and sort away from the original it
// came from. Node cannot set the separate Windows creation time, so only the
// modification time is aligned here; that is the one Explorer reads.
function stampCaptureTime(file, captureTime) {
  if (!captureTime) return;
  try { fs.utimesSync(file, captureTime, captureTime); } catch {}
}

// The overlay geometry comes from the same helper the video graph uses, which is
// what keeps the badge on the same visual line in a still and in a clip.
function jpegWatermarkFilters({ inkBox, scale = INK_WIDTH_RATIO, opacity = 1, centerYRatio = INK_CENTER_Y_RATIO }) {
  const parts = inkOverlayFilters({ inputIndex: 1, videoLabel: "[0:v]", scale, opacity, centerYRatio, ink: inkBox, canvas: (inkBox && inkBox.canvas) || null });
  return [parts.src, parts.sized, parts.composite].join(";") + ";[overlay]format=yuvj420p[out]";
}

// -q:v 1 is the encoder's best quality, and qmin/qmax have to be pinned too:
// without them the encoder clamps the requested scale and the flag alone gives
// 49.8 dB where the pinned form gives 51.2 dB.
function buildJpegExportArgs({ inputPath, outputPath, watermarkPath, filterGraph }) {
  return ["-y", "-v", "error", "-i", inputPath, "-i", watermarkPath, "-filter_complex", filterGraph, "-map", "[out]", "-frames:v", "1", "-q:v", "1", "-qmin", "1", "-qmax", "1", outputPath];
}

function runFfmpeg(ffmpegPath, args, { signal = null, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stderr = [];
    let settled = false;
    const abort = () => { try { child.kill("SIGKILL"); } catch {} };
    const detach = () => { if (signal) signal.removeEventListener("abort", abort); };
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", error => {
      if (settled) return;
      settled = true;
      detach();
      reject(error);
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      detach();
      if (signal && signal.aborted) { reject(new Error("Export canceled")); return; }
      if (code === 0) { resolve({ code }); return; }
      const detail = Buffer.concat(stderr).toString().trim().split("\n")[0] || "ffmpeg exited with code " + code;
      reject(new Error("Photo export failed: " + detail));
    });
    if (signal) { if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); }
  });
}

let photoSequence = 0;

// Writes the finished JPEG through a temporary file in the destination folder so
// an interrupted run never leaves a half-written photo where the real one should
// be. The temporary keeps the target extension: ffmpeg picks its muxer from it.
async function exportJpeg({ ffmpegPath, inputPath, outputPath, watermarkPath = null, inkBox = null, signal = null, spawnProcess = undefined }) {
  if (!inputPath || !outputPath) throw new Error("Photo export input and output paths are required");
  if (path.resolve(inputPath) === path.resolve(outputPath)) throw new Error("Photo export output must be different from the source file");
  const temporary = path.join(path.dirname(outputPath), ".dji-photo-" + process.pid + "-" + (++photoSequence) + path.extname(outputPath));
  let metadataCopied = true;
  try {
    if (watermarkPath && inkBox) {
      const filterGraph = jpegWatermarkFilters({ inkBox });
      await runFfmpeg(ffmpegPath, buildJpegExportArgs({ inputPath, outputPath: temporary, watermarkPath, filterGraph }), { signal, spawnProcess });
      metadataCopied = false;
      try { metadataCopied = copyJpegMetadata(inputPath, temporary); } catch { /* metadata is a bonus, never a reason to fail */ }
    } else {
      if (signal && signal.aborted) throw new Error("Export canceled");
      await fs.promises.copyFile(inputPath, temporary);
    }
    stampCaptureTime(temporary, captureTimeFor(inputPath, path.basename(outputPath)));
    const bytes = (await fs.promises.stat(temporary)).size;
    if (!bytes) throw new Error("Photo export produced an empty file");
    await fs.promises.rm(outputPath, { force: true });
    await fs.promises.rename(temporary, outputPath);
    return { outputPath, bytes, metadataCopied };
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

const api = { copyJpegMetadata, exifCaptureTime, parseExifStamp, parseNameStamp, captureTimeFor, stampCaptureTime, jpegWatermarkFilters, buildJpegExportArgs, exportJpeg };
if (typeof module !== "undefined" && module.exports) module.exports = api;
