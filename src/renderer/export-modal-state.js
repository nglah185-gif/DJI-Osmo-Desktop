(() => {
  // Pure state for the export progress dialog. DOM wiring lives in
  // renderer-phase3.js; everything here is reachable from Node so the phase
  // machine and the size/label formatting stay unit tested.

  const KB = 1024, MB = KB * 1024, GB = MB * 1024;

  // libx264 -crf 18 is quality targeted, not rate targeted, so no pre-export
  // number can be exact. Re-encoding an already-compressed camera file at CRF
  // 18 lands close to the source rate, so the source bitrate is the only
  // honest signal available without a trial encode. Callers must label the
  // result as an estimate.
  const ESTIMATE_VIDEO_FACTOR = 0.95;

  function numberOrNull(value) {
    if (value === "" || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function formatBytes(bytes) {
    const value = numberOrNull(bytes);
    if (value === null) return null;
    if (value >= GB) return (value / GB).toFixed(2) + " GB";
    if (value >= MB) return (value / MB).toFixed(1) + " MB";
    if (value >= KB) return Math.round(value / KB) + " KB";
    return value + " B";
  }

  // Bitrates are bits per second; sizes are bytes.
  function estimateOutputBytes({ durationSeconds, videoBitrate, audioBitrate }) {
    const duration = numberOrNull(durationSeconds);
    const video = numberOrNull(videoBitrate);
    if (duration === null || video === null) return null;
    const audio = numberOrNull(audioBitrate) || 0;
    return Math.round(duration * (video * ESTIMATE_VIDEO_FACTOR + audio) / 8);
  }

  function outputSizeFromValidation(validation) {
    return numberOrNull(validation && validation.format && validation.format.size);
  }

  function fileNameFromPath(outputPath) {
    const text = String(outputPath || "");
    if (!text) return "";
    const parts = text.split(/[\\/]/);
    return parts[parts.length - 1] || "";
  }

  function directoryFromPath(outputPath) {
    const text = String(outputPath || "");
    const match = /^(.*)[\\/][^\\/]+$/.exec(text);
    return match ? match[1] : "";
  }

  function initialState({ assetId, assetName = "", coverUrl = null, destination = "", durationSeconds = null, estimatedBytes = null } = {}) {
    return {
      assetId: assetId || null,
      assetName: String(assetName || ""),
      coverUrl: coverUrl || null,
      destination: String(destination || ""),
      durationSeconds: numberOrNull(durationSeconds),
      estimatedBytes: numberOrNull(estimatedBytes),
      actualBytes: null,
      pct: null,
      phase: "preparing",
      errorMessage: ""
    };
  }

  function applyProgress(state, pct) {
    // Distinct from numberOrNull: 0 is a real report and must stay determinate,
    // and a stray negative is clamped rather than dropped. Only absent or
    // non-numeric input leaves the dialog indeterminate.
    if (pct === "" || pct === null || pct === undefined) return state;
    const number = Number(pct);
    if (!Number.isFinite(number)) return state;
    const value = Math.max(0, Math.min(100, number));
    if (state.phase === "done" || state.phase === "canceled" || state.phase === "error") return state;
    // ffmpeg reports 100% the moment encoding ends, but the export is not on
    // disk until ffprobe validation and the atomic rename finish. Showing
    // "finalizing" is what keeps a large-file stall from looking like a freeze.
    return { ...state, pct: value, phase: value >= 100 ? "finalizing" : "encoding" };
  }

  function applyDestination(state, destination) {
    return { ...state, destination: String(destination || "") };
  }

  function applyCover(state, coverUrl) {
    return { ...state, coverUrl: coverUrl || null };
  }

  function applyDone(state, { outputPath = "", validation = null } = {}) {
    return {
      ...state,
      phase: "done",
      pct: 100,
      destination: outputPath ? String(outputPath) : state.destination,
      actualBytes: outputSizeFromValidation(validation)
    };
  }

  function applyCanceled(state) {
    return { ...state, phase: "canceled" };
  }

  function applyError(state, message) {
    return { ...state, phase: "error", errorMessage: String(message || "") };
  }

  const PHASE_KEYS = {
    preparing: "exportModal.preparing",
    encoding: "export.progress",
    finalizing: "exportModal.finalizing",
    done: "exportModal.done",
    canceled: "export.canceled",
    error: "exportModal.failed"
  };

  function view(state) {
    const settled = state.phase === "done" || state.phase === "canceled" || state.phase === "error";
    const pct = state.pct === null ? 0 : state.pct;
    const sizeBytes = state.actualBytes === null ? state.estimatedBytes : state.actualBytes;
    return {
      title: state.assetName,
      coverUrl: state.coverUrl,
      destination: state.destination,
      destinationName: fileNameFromPath(state.destination),
      destinationDir: directoryFromPath(state.destination),
      barWidth: (state.phase === "done" ? 100 : pct) + "%",
      // A determinate bar cannot be drawn before ffmpeg reports its first
      // timestamp, so the caller shows an indeterminate track instead.
      indeterminate: state.pct === null && !settled,
      percentText: state.pct === null ? "" : Math.round(pct) + "%",
      phase: state.phase,
      statusKey: PHASE_KEYS[state.phase] || PHASE_KEYS.preparing,
      statusParams: state.phase === "encoding" ? { pct: Math.round(pct) } : null,
      sizeText: formatBytes(sizeBytes),
      sizeIsEstimate: state.actualBytes === null && state.estimatedBytes !== null,
      errorMessage: state.errorMessage,
      cancelHidden: settled,
      closeHidden: !settled,
      revealHidden: state.phase !== "done",
      settled
    };
  }

  const api = { ESTIMATE_VIDEO_FACTOR, formatBytes, estimateOutputBytes, outputSizeFromValidation, fileNameFromPath, directoryFromPath, initialState, applyProgress, applyDestination, applyCover, applyDone, applyCanceled, applyError, view };
  if (typeof window !== "undefined") window.__exportModalState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
