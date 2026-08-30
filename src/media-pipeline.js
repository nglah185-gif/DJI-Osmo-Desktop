const path = require("node:path");
const crypto = require("node:crypto");
const { UNKNOWN } = require("./shared/models");
const { ScoredPairingEngine } = require("./pairing/scored-pairing-engine");
const { detectDjiColorMode } = require("./color/dji-color-mode");
const { DEFAULT_SCAN_CONCURRENCY, normalizeConcurrency, mapWithConcurrency } = require("./shared/map-concurrent");

class MediaPipeline {
  constructor({ deviceProvider, mediaAccess, mediaProbe, catalog, workspaceRoot, colorModeDetector }) { this.deviceProvider = deviceProvider; this.mediaAccess = mediaAccess; this.mediaProbe = mediaProbe; this.catalog = catalog; this.workspaceRoot = workspaceRoot; this.colorModeDetector = colorModeDetector || detectDjiColorMode; }
  async scan(options = {}) {
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
    onProgress({ stage: "DETECTING_STORAGE", completed: 0, total: 1 });
    const errors = [];
    const devices = await this.deviceProvider.discover();
    const roots = devices.filter(device => device.status === "POSSIBLE_DJI_STORAGE").map(device => ({ path: path.join(device.path, "DCIM"), device }));
    const hasDevice = devices.some(device => device.status === "POSSIBLE_DJI_STORAGE");
    const sampleRoot = path.join(this.workspaceRoot, "dji-test-media");
    if (!hasDevice) roots.push({ path: sampleRoot, device: { id: "offline-sample", kind: "Offline sample", path: sampleRoot, label: "V2 real media fixtures", status: "OFFLINE_SAMPLE", score: 100, evidence: { localFixture: true } } });
    const allFiles = [];
    const filePaths = [];
    const seen = new Set();
    for (const root of roots) {
      const files = await this.mediaAccess.listMediaFiles(root.path);
      for (const filePath of files) {
        const key = path.normalize(filePath).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        filePaths.push(filePath);
      }
    }
    let completedFiles = 0;
    onProgress({ stage: "SCANNING_MEDIA", completed: 0, total: filePaths.length });
    const records = await mapWithConcurrency(filePaths, normalizeConcurrency(options.probeConcurrency, DEFAULT_SCAN_CONCURRENCY), async filePath => {
      try {
        const stat = await this.mediaAccess.stat(filePath);
        const probe = await this.mediaProbe.probe(filePath);
        return { record: { id: makeId(filePath, stat), path: filePath, name: path.basename(filePath), extension: path.extname(filePath).slice(1).toLowerCase(), size: stat.size, lastWriteTime: stat.mtime.toISOString(), probe } };
      } catch (error) {
        return { error: { path: filePath, message: error.message } };
      } finally {
        completedFiles++;
        onProgress({ stage: "SCANNING_MEDIA", completed: completedFiles, total: filePaths.length });
      }
    });
    for (const result of records) {
      if (result.record) allFiles.push(result.record);
      else errors.push(result.error);
    }
    onProgress({ stage: "MATCHING_MEDIA", completed: allFiles.length, total: allFiles.length });
    const originals = allFiles.filter(file => file.extension === "mp4");
    const photos = allFiles.filter(file => ["jpg", "jpeg", "png"].includes(file.extension));
    const previews = allFiles.filter(file => file.extension === "lrf");
    const audioFiles = allFiles.filter(file => file.extension === "aac");
    const pairing = new ScoredPairingEngine().pair(originals, previews, audioFiles);
    const previewByOriginal = new Map(pairing.pairs.map(pair => [pair.original.id, pair]));
    const audioByOriginal = new Map();
    for (const candidate of pairing.audioCandidates) { if (!candidate.associatedOriginalId) continue; if (!audioByOriginal.has(candidate.associatedOriginalId)) audioByOriginal.set(candidate.associatedOriginalId, []); audioByOriginal.get(candidate.associatedOriginalId).push(candidate); }
    const colorModeByOriginal = new Map();
    for (const original of originals) {
      let detected;
      try { detected = await this.colorModeDetector(original.path, { headBytes: 262144 }); } catch (error) { detected = { mode: "UNKNOWN", evidence: { reason: "detector-error", message: String(error && error.message || error) } }; }
      colorModeByOriginal.set(original.id, detected);
    }
    const assets = originals.map(original => {
      const pair = previewByOriginal.get(original.id);
      const preview = pair ? pair.preview : UNKNOWN;
      const colorMode = colorModeByOriginal.get(original.id) || { mode: "UNKNOWN", evidence: null };
      return {
        id: original.id, cameraModel: inferCameraModel(original.probe), captureIdentity: original.probe.timecode !== UNKNOWN ? "timecode:" + original.probe.timecode : "name:" + original.name,
        original: publicFile(original), preview: preview === UNKNOWN ? UNKNOWN : publicFile(preview),
        externalAudioCandidates: (audioByOriginal.get(original.id) || []).map(({ associatedOriginalId, ...candidate }) => candidate),
        thumbnail: { kind: preview === UNKNOWN ? "none" : "attached-jpeg", source: preview === UNKNOWN ? "UNKNOWN" : preview.path },
        timing: { previewToOriginalOffsetMs: pair ? 0 : UNKNOWN, previewDurationMs: preview === UNKNOWN ? UNKNOWN : durationMs(preview.probe.duration), originalDurationMs: durationMs(original.probe.duration) },
        displayGeometry: { original: geometry(original.probe), preview: preview === UNKNOWN ? UNKNOWN : geometry(preview.probe) },
        colorDeclaration: { inputMode: "UNKNOWN", metadata: original.probe.color },
        djiColorMode: colorMode.mode, djiColorModeEvidence: colorMode.evidence || null, pairingEvidence: pair ? pair.evidence : UNKNOWN, verificationState: pair ? "CONFIRMED" : "UNKNOWN", captureMode: preview === UNKNOWN && (audioByOriginal.get(original.id) || []).length > 0 ? "SLOW_MOTION" : "STANDARD", captureModeEvidence: preview === UNKNOWN && (audioByOriginal.get(original.id) || []).length > 0 ? { reason: "no-lrf-with-aac", note: "DJI slow-motion clips store audio as a separate AAC and omit the LRF companion" } : { reason: "standard-companion-present" }
      };
    }).concat(photos.map(photo => ({ id: photo.id, mediaKind: "photo", cameraModel: UNKNOWN, captureIdentity: "name:" + photo.name, original: publicFile(photo), preview: UNKNOWN, externalAudioCandidates: [], thumbnail: { kind: "original-image", source: photo.path }, timing: { previewToOriginalOffsetMs: UNKNOWN, previewDurationMs: UNKNOWN, originalDurationMs: UNKNOWN }, displayGeometry: { original: geometry(photo.probe), preview: UNKNOWN }, colorDeclaration: { inputMode: "UNKNOWN", metadata: photo.probe && photo.probe.color }, djiColorMode: "UNKNOWN", djiColorModeEvidence: null, pairingEvidence: UNKNOWN, verificationState: "UNKNOWN", captureMode: "PHOTO", captureModeEvidence: { reason: "still-image" } })));
    onProgress({ stage: "READY", completed: assets.length, total: assets.length });
        const listedDevices = hasDevice ? devices : devices.concat([{ id: "offline-sample", kind: "Offline sample", path: sampleRoot, label: "V2 real media fixtures", status: "OFFLINE_SAMPLE", score: 100, evidence: { localFixture: true } }]);
    const snapshot = { devices: listedDevices, assets, files: allFiles.map(publicFile), pairing: { highConfidence: pairing.pairs.filter(pair => pair.evidence.status === "HIGH_CONFIDENCE").length, unmatchedPreviews: pairing.unmatchedPreviews.length, audioCandidates: pairing.audioCandidates.length }, status: devices.length ? "DEVICE_AND_OFFLINE_MEDIA_SCANNED" : "NO_DJI_CAMERA_DETECTED_OFFLINE_MEDIA_SCANNED", scannedAt: new Date().toISOString(), errors };
    this.catalog.replace(snapshot);
    return snapshot;
  }
}
function makeId(filePath, stat) { return crypto.createHash("sha256").update(path.normalize(filePath).toLowerCase() + "|" + stat.size + "|" + stat.mtimeMs).digest("hex").slice(0, 24); }
function publicFile(file) { const { deviceId, ...value } = file; return value; }
function durationMs(value) { return typeof value === "number" ? Math.round(value * 1000) : UNKNOWN; }
function geometry(probe) { const encodedWidth = probe.width; const encodedHeight = probe.height; const rotation = probe.rotation; const quarterTurn = typeof rotation === "number" && Math.abs(rotation) % 180 === 90; return { encodedWidth, encodedHeight, displayWidth: quarterTurn ? encodedHeight : encodedWidth, displayHeight: quarterTurn ? encodedWidth : encodedHeight, rotation, displayMatrix: probe.displayMatrix }; }
function inferCameraModel(probe) {
  const value = String(probe && probe.metadata && [probe.metadata.encoder, probe.metadata.handler_name, probe.metadata.model].filter(Boolean).join(" ") || "");
  if (/OsmoAction6|Action 6/i.test(value)) return "DJI Osmo Action 6";
  if (/OsmoAction5|Action 5/i.test(value)) return "DJI Osmo Action 5 Pro";
  if (/OsmoAction4|Action 4/i.test(value)) return "DJI Osmo Action 4 / HG302";
  if (/OsmoAction3|Action 3/i.test(value)) return "DJI Osmo Action 3";
  if (/OsmoPocket4Pro|Pocket 4 Pro/i.test(value)) return "DJI Osmo Pocket 4 Pro";
  if (/OsmoPocket4|Pocket 4/i.test(value)) return "DJI Osmo Pocket 4";
  if (/OsmoPocket3|Pocket 3/i.test(value)) return "DJI Osmo Pocket 3";
  if (/OsmoNano|Osmo Nano|Nano/i.test(value)) return "DJI Osmo Nano";
  if (/OsmoAction|Osmo Action/i.test(value)) return "DJI Osmo Action";
  return UNKNOWN;
}
module.exports = { MediaPipeline, geometry, inferCameraModel, mapWithConcurrency };
