const path = require("node:path");
const crypto = require("node:crypto");
const { detectDjiColorMode } = require("../color/dji-color-mode");
const { ScoredPairingEngine } = require("../pairing/scored-pairing-engine");
const { DEFAULT_SCAN_CONCURRENCY, normalizeConcurrency, mapWithConcurrency } = require("../shared/map-concurrent");

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".mkv"]);
const COMPANION_EXTS = new Set([".lrf", ".aac"]);
const MEDIA_EXTS = new Set([...VIDEO_EXTS, ...COMPANION_EXTS]);
const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png"]);
for (const ext of PHOTO_EXTS) MEDIA_EXTS.add(ext);

function fingerprint(filePath, stat) {
  return crypto.createHash("sha256")
    .update(path.normalize(filePath).toLowerCase() + "|" + stat.size + "|" + stat.mtimeMs)
    .digest("hex")
    .slice(0, 24);
}

function publicFile(record) {
  return {
    id: record.id,
    path: record.path,
    name: record.name,
    extension: record.extension,
    size: record.size,
    lastWriteTime: record.lastWriteTime,
    probe: record.probe
  };
}

function geometry(probe) {
  const encodedWidth = probe && probe.width;
  const encodedHeight = probe && probe.height;
  const rotation = probe && probe.rotation;
  const quarterTurn = typeof rotation === "number" && Math.abs(rotation) % 180 === 90;
  return {
    encodedWidth,
    encodedHeight,
    displayWidth: quarterTurn ? encodedHeight : encodedWidth,
    displayHeight: quarterTurn ? encodedWidth : encodedHeight,
    rotation,
    displayMatrix: probe && probe.displayMatrix
  };
}

async function scanLocalDirectory(rootPath, options) {
  const fs = (options && options.fs) || require("node:fs/promises");
  const probe = (options && options.probe) || null;
  const onError = options && typeof options.onError === "function" ? options.onError : () => {};
  const colorModeDetector = (options && options.colorModeDetector) || detectDjiColorMode;
  // User-selected local folders should include normal nested project layouts
  // (for example year/month/camera folders). Keep an explicit limit available
  // for callers that scan removable media or selected-file groups, but avoid
  // silently dropping media after only four directory levels.
  const maxDepth = options && options.maxDepth !== undefined ? options.maxDepth : 32;
  const includeFile = options && typeof options.includeFile === "function" ? options.includeFile : null;
  const probeConcurrency = normalizeConcurrency(options && options.probeConcurrency, DEFAULT_SCAN_CONCURRENCY);
  const records = [];

  async function walk(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch (error) { onError({ path: current, message: error.message }); return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
      const extension = path.extname(entry.name).toLowerCase();
      if (entry.name.startsWith(".dji-export-")) continue;
      if (!entry.isFile() || !MEDIA_EXTS.has(extension)) continue;
      if (includeFile && !includeFile(full, extension)) continue;
      const stat = await fs.stat(full).catch(error => { onError({ path: full, message: error.message }); return null; });
      if (!stat) continue;
      records.push({ id: fingerprint(full, stat), path: full, name: entry.name, extension: extension.slice(1), size: stat.size, lastWriteTime: stat.mtime.toISOString(), probe: {} });
    }
  }

  await walk(rootPath, 0);
  if (probe) {
    const probeResults = await mapWithConcurrency(records, probeConcurrency, async record => {
      try { return { probe: await probe(record.path) }; }
      catch (error) { return { error: { path: record.path, message: error.message } }; }
    });
    for (let index = 0; index < records.length; index++) {
      const result = probeResults[index];
      records[index].probe = result.probe || {};
      if (result.error) onError(result.error);
    }
  }
  const originals = records.filter(record => VIDEO_EXTS.has("." + record.extension));
  const photos = records.filter(record => PHOTO_EXTS.has("." + record.extension));
  const previews = records.filter(record => record.extension === "lrf");
  const audioFiles = records.filter(record => record.extension === "aac");
  const pairing = new ScoredPairingEngine().pair(originals, previews, audioFiles);
  const previewByOriginal = new Map(pairing.pairs.map(pair => [pair.original.id, pair]));
  const audioByOriginal = new Map();
  for (const candidate of pairing.audioCandidates) {
    if (!candidate.associatedOriginalId) continue;
    if (!audioByOriginal.has(candidate.associatedOriginalId)) audioByOriginal.set(candidate.associatedOriginalId, []);
    audioByOriginal.get(candidate.associatedOriginalId).push(candidate);
  }

  const assets = [];
  for (const original of originals) {
    const pair = previewByOriginal.get(original.id);
    const preview = pair ? publicFile(pair.preview) : "UNKNOWN";
    const audioCandidates = (audioByOriginal.get(original.id) || []).map(({ associatedOriginalId, ...candidate }) => candidate);
    let djiColorMode = "UNKNOWN", djiColorModeEvidence = null;
    try {
      const detected = await colorModeDetector(original.path);
      djiColorMode = detected.mode;
      djiColorModeEvidence = detected.evidence || null;
    } catch {}
    const slowMotion = preview === "UNKNOWN" && audioCandidates.length > 0;
    assets.push({
      id: "local:" + original.id,
      source: "local",
      original: publicFile(original),
      preview,
      displayGeometry: { original: geometry(original.probe), preview: preview === "UNKNOWN" ? "UNKNOWN" : geometry(preview.probe) },
      externalAudioCandidates: audioCandidates,
      thumbnail: { kind: preview === "UNKNOWN" ? "first-frame" : "attached-jpeg", source: preview === "UNKNOWN" ? "UNKNOWN" : preview.path },
      pairingEvidence: pair ? pair.evidence : "UNKNOWN",
      captureMode: slowMotion ? "SLOW_MOTION" : "STANDARD",
      captureModeEvidence: slowMotion ? { reason: "no-lrf-with-aac" } : { reason: preview === "UNKNOWN" ? "local-first-frame" : "standard-companion-present" },
      djiColorMode,
      djiColorModeEvidence,
      localRoot: rootPath
    });
  }
  for (const photo of photos) {
    assets.push({ id: "local:" + photo.id, source: "local", mediaKind: "photo", original: publicFile(photo), preview: "UNKNOWN", displayGeometry: { original: geometry(photo.probe), preview: "UNKNOWN" }, externalAudioCandidates: [], thumbnail: { kind: "original-image", source: photo.path }, pairingEvidence: "UNKNOWN", captureMode: "PHOTO", captureModeEvidence: { reason: "still-image" }, djiColorMode: "UNKNOWN", djiColorModeEvidence: null, localRoot: rootPath });
  }
  return assets;
}

module.exports = { scanLocalDirectory, fingerprint, geometry, VIDEO_EXTS, PHOTO_EXTS, MEDIA_EXTS };
