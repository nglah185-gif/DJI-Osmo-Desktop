const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Concurrency guard: one transcode per (assetId, signature) at a time.
const inflight = new Map();

function runFfmpeg(ffmpeg, args, onProgress, durationSeconds, entry, spawnProcess = spawn) {
  return new Promise(resolve => {
    const child = spawnProcess(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    entry.child = child;
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 8192) stderr = stderr.slice(-4096); });
    let buffer = "";
    const report = text => {
      if (onProgress && durationSeconds > 0) {
        let secs = null;
        const us = /out_time_us=(\d+)/.exec(text);
        const ms = /out_time_ms=(\d+)/.exec(text);
        if (us) secs = Number(us[1]) / 1000000; else if (ms) secs = Number(ms[1]) / 1000;
        if (secs !== null) {
          const pct = Math.min(99, Math.round(secs / durationSeconds * 100));
          onProgress(pct);
        }
      }
    };
    // ffmpeg -progress pipe:1 writes key=value blocks to stdout.
    child.stdout.on("data", chunk => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
        if (/^out_time/.test(line)) report(line);
      }
    });
    child.on("error", () => resolve(false));
    child.on("close", code => { if (entry.child === child) entry.child = null; resolve(code === 0 && !entry.canceled); });
  });
}

function signatureOf(p) { try { const s = fs.statSync(p); return Math.round(s.mtimeMs) + "-" + s.size; } catch { return ""; } }

function validateProxy(filePath, ffprobe = process.env.FFPROBE_PATH || "ffprobe", spawnProcess = spawn) {
  return new Promise(resolve => {
    let child;
    try { child = spawnProcess(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { resolve(false); return; }
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.on("error", () => resolve(false));
    child.on("close", code => resolve(code === 0 && Number(output.trim()) > 0));
  });
}

// Keep aspect ratio (FAR) and pad to a 640x360 letterboxed canvas so portrait
// clips are never stretched. The previous per-axis min() scale distorted
// non-16:9 sources.
const SCALE_FILTER = "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1";

async function ensureFallbackProxy({ ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", assetId, originalPath, cacheRoot, durationSeconds = 0, onProgress = null, spawnProcess = spawn }) {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const signature = signatureOf(originalPath);
  const output = path.join(cacheRoot, assetId + (signature ? "-" + signature : "") + ".mp4");
  // Keep the .mp4 suffix so ffmpeg selects the MP4 muxer, while the partial
  // file remains invisible to scanners until the atomic rename completes.
  const temporaryOutput = output.replace(/\.mp4$/i, ".part.mp4");
  if (fs.existsSync(output)) {
    if (await validateProxy(output)) return output;
    try { fs.unlinkSync(output); } catch { /* rebuilt below */ }
  }
  const key = assetId + "|" + signature;
  if (inflight.has(key)) return inflight.get(key).promise;
  const entry = { assetId, key, child: null, canceled: false, promise: null };
  entry.promise = (async () => {
    onProgress && onProgress(1);
    const ok = await runFfmpeg(ffmpeg, ["-y", "-v", "error", "-progress", "pipe:1", "-i", originalPath, "-vf", SCALE_FILTER, "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-movflags", "+faststart", temporaryOutput], onProgress, durationSeconds, entry, spawnProcess);
    if (!ok || entry.canceled || !fs.existsSync(temporaryOutput)) { try { fs.unlinkSync(temporaryOutput); } catch {} return null; }
    try { fs.renameSync(temporaryOutput, output); } catch { try { fs.unlinkSync(temporaryOutput); } catch {} return null; }
    onProgress && onProgress(100);
    return output;
  })();
  inflight.set(key, entry);
  try { return await entry.promise; } finally { if (inflight.get(key) === entry) inflight.delete(key); }
}

function cancelFallbackProxy(assetId) {
  let canceled = 0;
  for (const entry of inflight.values()) {
    if (entry.assetId !== assetId) continue;
    entry.canceled = true;
    canceled++;
    if (entry.child) {
      try { entry.child.kill("SIGKILL"); } catch { /* already exited */ }
    }
  }
  return canceled;
}

function shutdownFallbackProxies() {
  for (const entry of inflight.values()) {
    entry.canceled = true;
    if (entry.child) {
      try { entry.child.kill("SIGKILL"); } catch { /* already exited */ }
    }
  }
}

module.exports = { ensureFallbackProxy, cancelFallbackProxy, shutdownFallbackProxies, validateProxy, SCALE_FILTER };
