const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function run(command, args) { return new Promise(resolve => { const child = spawn(command, args, { windowsHide: true, stdio: "ignore" }); child.on("error", () => resolve(false)); child.on("close", code => resolve(code === 0)); }); }
function copyIfExists(source, target) { try { fs.copyFileSync(source, target); return true; } catch { return false; } }
function signatureOf(p) { try { const s = fs.statSync(p); return Math.round(s.mtimeMs) + "-" + s.size; } catch { return ""; } }
function cacheName(assetId, sourceSignature) { return assetId + (sourceSignature ? "-" + sourceSignature : "") + ".jpg"; }

// Native priority chain for list thumbnails: THM -> SCR -> LRF attached -> LRF first frame -> Original first frame -> null.
async function ensureThumbnail({ ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", assetId, previewPath, originalPath, thmPath = null, scrPath = null, cacheRoot }) {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const signature = signatureOf(thmPath || scrPath) || signatureOf(originalPath);
  const output = path.join(cacheRoot, cacheName(assetId, signature));
  if (fs.existsSync(output)) return output;
  if (thmPath && copyIfExists(thmPath, output)) return output;
  if (scrPath && copyIfExists(scrPath, output)) return output;
  if (originalPath && /\.(?:jpe?g|png)$/i.test(originalPath) && copyIfExists(originalPath, output)) return output;
  if (previewPath) {
    if (await run(ffmpeg, ["-y", "-v", "error", "-i", previewPath, "-map", "0:v:1", "-frames:v", "1", "-q:v", "3", output])) return output;
    if (await run(ffmpeg, ["-y", "-v", "error", "-ss", "0.5", "-i", previewPath, "-map", "0:v:0", "-frames:v", "1", "-q:v", "3", output])) return output;
  }
  if (originalPath && await run(ffmpeg, ["-y", "-v", "error", "-ss", "0.5", "-i", originalPath, "-frames:v", "1", "-q:v", "3", output])) return output;
  return null;
}

// Poster chain for selected media: SCR -> LRF attached -> LRF first frame -> Original first frame -> null.
async function ensurePoster({ ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", assetId, previewPath, originalPath, scrPath = null, posterRoot }) {
  fs.mkdirSync(posterRoot, { recursive: true });
  const signature = signatureOf(scrPath) || signatureOf(originalPath);
  const output = path.join(posterRoot, cacheName(assetId, signature));
  if (fs.existsSync(output)) return output;
  if (scrPath && copyIfExists(scrPath, output)) return output;
  if (originalPath && /\.(?:jpe?g|png)$/i.test(originalPath) && copyIfExists(originalPath, output)) return output;
  if (previewPath) {
    if (await run(ffmpeg, ["-y", "-v", "error", "-i", previewPath, "-map", "0:v:1", "-frames:v", "1", "-q:v", "3", output])) return output;
    if (await run(ffmpeg, ["-y", "-v", "error", "-ss", "0.5", "-i", previewPath, "-map", "0:v:0", "-frames:v", "1", "-q:v", "3", output])) return output;
  }
  if (originalPath && await run(ffmpeg, ["-y", "-v", "error", "-ss", "0.5", "-i", originalPath, "-frames:v", "1", "-q:v", "3", output])) return output;
  return null;
}

function placeholderState(hasPreview) { return { kind: "PLACEHOLDER", label: hasPreview ? "NO_THUMBNAIL" : "PREVIEW_UNAVAILABLE" }; }

function resolveCachePath({ assetId, thmPath = null, scrPath = null, originalPath = null, cacheRoot }) { const signature = signatureOf(thmPath || scrPath) || signatureOf(originalPath); return path.join(cacheRoot, cacheName(assetId, signature)); }

module.exports = { ensureThumbnail, ensurePoster, placeholderState, resolveCachePath };
