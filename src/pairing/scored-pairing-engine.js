const path = require("node:path");
const { UNKNOWN } = require("../shared/models");
function baseName(filePath) { return path.basename(filePath, path.extname(filePath)).trim().toLocaleLowerCase(); }
function equalKnown(a, b) { return a !== UNKNOWN && b !== UNKNOWN && a !== undefined && b !== undefined && a === b; }
function durationScore(a, b) { if (a === UNKNOWN || b === UNKNOWN) return 0; const difference = Math.abs(a - b); return difference <= 0.05 ? 10 : difference <= 0.25 ? 5 : 0; }
function encoderScore(a, b) { const left = a.metadata && a.metadata.encoder; const right = b.metadata && b.metadata.encoder; return left && right && left === right ? 5 : 0; }
function timestampDistance(a, b) { const left = Date.parse(a); const right = Date.parse(b); return Number.isFinite(left) && Number.isFinite(right) ? Math.abs(left - right) : Infinity; }
function fpsValue(probe) { return probe && probe.fps && typeof probe.fps.value === "number" ? probe.fps.value : null; }

class ScoredPairingEngine {
  pair(originals, previews, audioFiles) {
    const pairs = [];
    const usedPreviews = new Set();
    for (const original of originals) {
      const ranked = previews.filter(preview => !usedPreviews.has(preview.id)).map(preview => {
        const factors = {
          basename: baseName(original.path) === baseName(preview.path) ? 30 : 0,
          sameDirectory: path.dirname(original.path).toLocaleLowerCase() === path.dirname(preview.path).toLocaleLowerCase() ? 30 : 0,
          timecode: equalKnown(original.probe.timecode, preview.probe.timecode) ? 30 : 0,
          creationTime: equalKnown(original.probe.creationTime, preview.probe.creationTime) ? 20 : 0,
          duration: durationScore(original.probe.duration, preview.probe.duration),
          djiEncoder: encoderScore(original.probe, preview.probe),
          roleConsistency: preview.probe.codec === "h264" && preview.probe.width === 1280 && preview.probe.height === 720 ? 5 : 0
        };
        const score = Object.values(factors).reduce((sum, value) => sum + value, 0);
        const notes = [];
        const originalFps = fpsValue(original.probe), previewFps = fpsValue(preview.probe);
        if (originalFps !== null && previewFps !== null && originalFps !== previewFps) notes.push("FPS differs for preview role; matching uses time.");
        if (original.probe.duration !== UNKNOWN && preview.probe.duration !== UNKNOWN && Math.abs(original.probe.duration - preview.probe.duration) > 0.05) notes.push("Duration differs beyond nominal tolerance.");
        return { preview, score, factors, notes };
      }).sort((a, b) => b.score - a.score);
      const best = ranked[0];
      if (!best) continue;
      const second = ranked[1];
      const ambiguous = second && best.score - second.score < 10;
      const status = ambiguous ? "CONFLICT" : best.score >= 75 ? "HIGH_CONFIDENCE" : best.score >= 45 ? "CANDIDATE" : "UNKNOWN";
      const evidence = { originalId: original.id, previewId: best.preview.id, score: best.score, factors: best.factors, status, notes: ambiguous ? best.notes.concat("Top preview candidates are too close to disambiguate.") : best.notes };
      if (status === "HIGH_CONFIDENCE") {
        pairs.push({ original, preview: best.preview, evidence });
        usedPreviews.add(best.preview.id);
      }
    }
    const audioCandidates = audioFiles.map(audio => {
      const ranked = originals.map(original => {
        const factors = { basename: baseName(audio.path) === baseName(original.path) ? 55 : 0, nearbyFileTime: timestampDistance(audio.lastWriteTime, original.lastWriteTime) <= 120000 ? 25 : 0, audioOnlyRole: audio.probe.codec === "aac" ? 20 : 0 };
        return { originalId: original.id, score: Object.values(factors).reduce((sum, value) => sum + value, 0) };
      }).sort((a, b) => b.score - a.score);
      const best = ranked[0];
      return { id: audio.id, path: audio.path, basename: baseName(audio.path), duration: audio.probe.duration, lastWriteTime: audio.lastWriteTime, sampleRate: audio.probe.sampleRate, channels: audio.probe.channels, bitrate: audio.probe.bitrate, associationScore: best ? best.score : 0, syncStatus: "UNKNOWN", associatedOriginalId: best && best.score > 0 ? best.originalId : null };
    }).filter(candidate => candidate.associationScore > 0);
    return { pairs, unmatchedPreviews: previews.filter(preview => !usedPreviews.has(preview.id)), audioCandidates };
  }
}
module.exports = { ScoredPairingEngine, baseName, durationScore };
