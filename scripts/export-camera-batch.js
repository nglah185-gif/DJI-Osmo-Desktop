"use strict";

// Unattended export of the whole camera card: every video gets the watermark,
// D-Log video additionally gets its Rec.709 restoration, every photo JPG gets
// the watermark.
//
// It is deliberately non-destructive. A same-name file in the destination is
// never overwritten: if one exists, the new export is written with " (2)",
// " (3)" and so on. That matters because the destination already held
// byte-identical plain copies of most of the card, and replacing those would
// have destroyed the only copy of the originals.
//
// Progress and outcomes go to a log beside the snapshot, and every finished
// item is recorded in a manifest so a restart resumes instead of redoing hours
// of work. On a clean finish the machine is shut down; a fatal problem leaves
// it running with the log explaining why.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const PROJECT = path.resolve(__dirname, "..");
const WORKSPACE = path.resolve(PROJECT, "..");
const FFMPEG = path.join(PROJECT, "bin", "ffmpeg.exe");
const FFPROBE = path.join(PROJECT, "bin", "ffprobe.exe");
const INK_CACHE = path.join(process.env.APPDATA || PROJECT, "dji-osmo-desktop-v2", "watermark-ink");

const JOB_DIR = process.env.EXPORT_JOB_DIR || "E:\\_dji_export_job";
const SNAPSHOT = path.join(JOB_DIR, "snapshot.json");
const LOG_PATH = path.join(JOB_DIR, "export.log");
const MANIFEST = path.join(JOB_DIR, "done.json");
const DEST = process.env.EXPORT_DEST || "D:\\拍摄\\OSMO_Action4";
const WATERMARK_ID = process.env.EXPORT_WATERMARK || "action4.official.oa4";
const LIMIT = Math.max(0, Number(process.env.EXPORT_LIMIT) || 0);
const SHUTDOWN = process.env.EXPORT_SHUTDOWN !== "0";
const MIN_FREE_BYTES = 30 * 1024 * 1024 * 1024;

const { createOfficialLutRegistry } = require("../src/color/lut-registry");
const { createEditorEffectGraph } = require("../src/color/editor-effect-graph");
const { createEffectGraph } = require("../src/color/effect-graph");
const { technicalTransformFor } = require("../src/color/auto-restore");
const { FfmpegExportRenderer } = require("../src/renderers/ffmpeg-export-renderer");
const { createWatermarkRegistry } = require("../src/watermark/watermark-registry");
const { inkOverlayFilters, INK_CENTER_Y_RATIO, INK_WIDTH_RATIO } = require("../src/watermark/watermark-position");

const started = Date.now();
function log(message) {
  const line = "[" + new Date().toISOString().replace("T", " ").slice(0, 19) + "] " + message;
  try { fs.appendFileSync(LOG_PATH, line + "\n"); } catch {}
  console.log(line);
}
function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function saveJson(file, value) { try { fs.writeFileSync(file, JSON.stringify(value)); } catch {} }
function freeBytes(drive) { try { return fs.statfsSync(drive + "\\").bavail * fs.statfsSync(drive + "\\").bsize; } catch { return Infinity; } }

// Never overwrite: the first free "name (n)" wins.
function targetPath(directory, fileName) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension) || "export";
  let candidate = path.join(directory, fileName);
  let counter = 1;
  while (fs.existsSync(candidate)) candidate = path.join(directory, stem + " (" + (++counter) + ")" + extension);
  return candidate;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ffmpeg's mjpeg output carries no EXIF, so a watermarked photo would lose the
// capture time, GPS and maker notes that make it findable later. The source's
// APP1/APP2/APP13 segments are copied into the finished file byte for byte,
// after the JFIF header, which is where readers expect them.
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

// The machine must not fall asleep mid-job: 12 hours of unattended work would
// otherwise stop at the first idle timeout. ES_CONTINUOUS | ES_SYSTEM_REQUIRED
// is per-thread, so it is held by a child that stays alive with the job.
let keepAwake = null;
function startKeepAwake() {
  const script = "Add-Type -Namespace W -Name N -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; [W.N]::SetThreadExecutionState(0x80000001) | Out-Null; Start-Sleep -Seconds 86400";
  try {
    keepAwake = spawn("powershell", ["-NoProfile", "-Command", script], { windowsHide: true, stdio: "ignore" });
    log("sleep prevention active");
  } catch (error) { log("WARN could not start sleep prevention: " + error.message); }
}
function stopKeepAwake() { if (keepAwake) { try { keepAwake.kill(); } catch {} keepAwake = null; } }

(async () => {
  fs.mkdirSync(JOB_DIR, { recursive: true });
  fs.mkdirSync(DEST, { recursive: true });
  log("=== export start: " + SNAPSHOT + " -> " + DEST + " ===");

  if (!fs.existsSync(FFMPEG)) throw new Error("missing " + FFMPEG + " (the full ffmpeg build with libplacebo)");
  if (!fs.existsSync(SNAPSHOT)) throw new Error("missing snapshot " + SNAPSHOT);

  const lutRegistry = createOfficialLutRegistry(WORKSPACE);
  const watermarkRegistry = createWatermarkRegistry(WORKSPACE, { cacheRoot: INK_CACHE });
  const badge = watermarkRegistry.get(WATERMARK_ID);
  if (!badge) throw new Error("watermark " + WATERMARK_ID + " is not registered");
  const inkBox = await watermarkRegistry.ensureInkBox(WATERMARK_ID);
  if (!inkBox) throw new Error("watermark ink box could not be measured");
  log("watermark: " + badge.id + " -> " + path.basename(badge.path) + " ink " + inkBox.width + "x" + inkBox.height);

  const snapshot = loadJson(SNAPSHOT, null);
  if (!snapshot || !Array.isArray(snapshot.assets)) throw new Error("snapshot has no assets");
  const videos = snapshot.assets.filter(a => a.mediaKind !== "photo");
  const photos = snapshot.assets.filter(a => a.mediaKind === "photo");
  log("card: " + videos.length + " videos, " + photos.length + " photos");

  const done = loadJson(MANIFEST, {});
  const renderer = new FfmpegExportRenderer({ ffmpegPath: FFMPEG, cacheRoot: path.join(JOB_DIR, "cache") });
  let completed = 0, failed = 0, bytes = 0;
  const failures = [];

  async function videoGraphFor(asset) {
    const transform = technicalTransformFor(asset);
    const editorGraph = createEditorEffectGraph({ technicalTransform: transform, creativeLook: "", watermark: { enabled: false } });
    return {
      transform,
      graph: createEffectGraph({
        ...editorGraph,
        overlays: [{
          kind: "image", path: badge.path, resourceId: badge.id, sha256: badge.sha256,
          inkBox, canvasSize: inkBox.canvas || null,
          position: { x: 0.5, y: 1 }, scale: INK_WIDTH_RATIO, opacity: 1, enabled: true
        }]
      })
    };
  }

  async function exportVideo(asset) {
    const { graph, transform } = await videoGraphFor(asset);
    const output = targetPath(DEST, asset.original.name);
    let lastLogged = -1;
    const result = await renderer.render({
      inputPath: asset.original.path, outputPath: output, graph, lutRegistry, styleRegistry: null,
      timestampSeconds: 0,
      onProgress: pct => { const step = Math.floor(pct / 25); if (step > lastLogged) { lastLogged = step; if (step < 4) log("    " + path.basename(output) + " " + pct + "%"); } }
    });
    const size = fs.statSync(output).size;
    return { output, size, detail: "transcode:" + transform + " lut=" + result.lutEngine + " enc=" + result.encoder + " " + (result.elapsedMs / 1000).toFixed(1) + "s" };
  }

  // A photo carries no colour pipeline, so it is one overlay and one JPEG
  // encode. The badge geometry comes from the same helper the video graph uses,
  // which is what keeps the mark on the same visual line in both.
  function exportPhoto(asset) {
    const output = targetPath(DEST, asset.original.name);
    const parts = inkOverlayFilters({ inputIndex: 1, videoLabel: "[0:v]", scale: INK_WIDTH_RATIO, opacity: 1, centerYRatio: INK_CENTER_Y_RATIO, ink: inkBox, canvas: inkBox.canvas || null });
    const chain = [parts.src, parts.sized, parts.composite].join(";") + ";[overlay]format=yuvj420p[out]";
    // -q:v 1 is the encoder's best quality, and qmin/qmax have to be pinned too:
    // without them the encoder clamps the requested scale and the flag alone
    // gives 49.8 dB where the pinned form gives 51.2 dB.
    execFileSync(FFMPEG, ["-y", "-v", "error", "-i", asset.original.path, "-i", badge.path, "-filter_complex", chain, "-map", "[out]", "-frames:v", "1", "-q:v", "1", "-qmin", "1", "-qmax", "1", output], { stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    let metadata = "no-exif";
    try { metadata = copyJpegMetadata(asset.original.path, output) ? "exif-copied" : "no-exif"; }
    catch (error) { metadata = "exif-copy-failed: " + String(error.message).split("\n")[0]; }
    const size = fs.statSync(output).size;
    return { output, size, detail: "photo-watermark " + metadata };
  }

  const queue = [...videos.map(a => ({ kind: "video", asset: a })), ...photos.map(a => ({ kind: "photo", asset: a }))];
  const total = LIMIT > 0 ? Math.min(LIMIT, queue.length) : queue.length;
  let index = 0;

  for (const item of queue) {
    if (index >= total) break;
    const name = item.asset.original.name;
    const key = item.kind + ":" + item.asset.id;
    if (done[key] && fs.existsSync(done[key])) { index++; completed++; continue; }
    if (freeBytes("D") < MIN_FREE_BYTES) { log("ABORT: D: free space below " + (MIN_FREE_BYTES / 1073741824) + " GB"); break; }

    const itemStarted = Date.now();
    try {
      const result = item.kind === "video" ? await exportVideo(item.asset) : exportPhoto(item.asset);
      done[key] = result.output;
      saveJson(MANIFEST, done);
      completed++; bytes += result.size;
      const rate = (bytes / 1048576) / ((Date.now() - started) / 1000);
      const remaining = (queue.length - index - 1);
      const etaHours = rate > 0 ? (remaining * (bytes / Math.max(1, completed)) / 1048576 / rate) / 3600 : 0;
      log("OK  " + (index + 1) + "/" + queue.length + "  " + path.basename(result.output) + "  " + (result.size / 1048576).toFixed(0) + "MB  " + result.detail + "  (" + ((Date.now() - itemStarted) / 1000).toFixed(0) + "s, ETA ~" + etaHours.toFixed(1) + "h)");
    } catch (error) {
      failed++;
      failures.push(name + ": " + String(error && error.message || error).split("\n")[0]);
      log("FAIL " + (index + 1) + "/" + queue.length + "  " + name + "  " + String(error && error.message || error).split("\n")[0]);
    }
    index++;
  }

  const elapsedHours = (Date.now() - started) / 3600000;
  log("=== finished: " + completed + " done, " + failed + " failed, " + (bytes / 1073741824).toFixed(1) + " GB written, " + elapsedHours.toFixed(2) + "h ===");
  for (const failure of failures.slice(0, 40)) log("  failed: " + failure);
  if (failures.length > 40) log("  ... and " + (failures.length - 40) + " more");

  stopKeepAwake();
  const fatal = completed === 0 && failed > 0;
  if (SHUTDOWN && !fatal) {
    log("shutting down in 120s (failures: " + failed + ")");
    try { execFileSync("shutdown", ["/s", "/t", "120"], { windowsHide: true }); } catch (error) { log("shutdown failed: " + error.message); }
  } else if (fatal) {
    log("NOT shutting down: the job failed before producing anything; see the log above");
  } else {
    log("shutdown disabled by EXPORT_SHUTDOWN=0");
  }
  process.exit(0);
})().catch(error => {
  stopKeepAwake();
  log("FATAL " + String(error && error.stack || error));
  log("NOT shutting down because the job could not start");
  process.exit(1);
});
