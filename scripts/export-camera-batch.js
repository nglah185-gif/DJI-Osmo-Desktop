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
const { INK_WIDTH_RATIO } = require("../src/watermark/watermark-position");
// The still path is shared with the GUI batch so a script run and a click run
// produce the same bytes, including the EXIF and the capture time.
const { exportJpeg, captureTimeFor, stampCaptureTime } = require("../src/renderers/jpeg-export");

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
    stampCaptureTime(output, captureTimeFor(asset.original.path, asset.original.name));
    const size = fs.statSync(output).size;
    return { output, size, detail: "transcode:" + transform + " lut=" + result.lutEngine + " enc=" + result.encoder + " " + (result.elapsedMs / 1000).toFixed(1) + "s" };
  }

  // A photo carries no colour pipeline, so it is one overlay and one JPEG
  // encode, with the camera's EXIF and capture time carried across.
  async function exportPhoto(asset) {
    const output = targetPath(DEST, asset.original.name);
    const result = await exportJpeg({
      ffmpegPath: FFMPEG,
      inputPath: asset.original.path,
      outputPath: output,
      watermarkPath: badge.path,
      inkBox
    });
    return { output, size: result.bytes, detail: "photo-watermark " + (result.metadataCopied ? "exif-copied" : "no-exif") };
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
      const result = item.kind === "video" ? await exportVideo(item.asset) : await exportPhoto(item.asset);
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
