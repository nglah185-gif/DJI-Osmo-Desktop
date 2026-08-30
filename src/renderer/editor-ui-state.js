(() => {
  function numberOrDefault(value, fallback) {
    if (value === "" || value === null || value === undefined) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function watermarkFromControls(values, positions) {
    return {
      id: values.id || "action4.official.oa4",
      enabled: !!values.enabled,
      scale: numberOrDefault(values.scale, 0.195),
      opacity: numberOrDefault(values.opacity, 1),
      position: positions[values.position] || positions.bottomCenter || positions.bottomRight
    };
  }

  function createSerialRunner() {
    let pending = Promise.resolve();
    return task => {
      const next = pending.catch(() => {}).then(task);
      pending = next;
      return next;
    };
  }

  // UI sliders and select controls can emit many updates while ffmpeg is still
  // rebuilding a preview. Keep the serial safety guarantee for the request
  // currently running, but discard queued intermediate states so the last user
  // choice is rendered promptly.
  function createLatestRunner() {
    let pending = Promise.resolve();
    let generation = 0;
    return task => {
      const token = ++generation;
      const next = pending.catch(() => {}).then(() => token === generation ? task() : undefined);
      pending = next;
      return next;
    };
  }

  function switchMode(mode, handlers) {
    return mode === "edit" ? handlers.edit() : handlers.browse();
  }

  function snapshotItems(snapshot, key) {
    return snapshot && Array.isArray(snapshot[key]) ? snapshot[key] : [];
  }

  function secondsFromMicroseconds(value) {
    return numberOrDefault(value, 0) / 1000000;
  }

  function microsecondsFromSeconds(value) {
    return Math.max(0, numberOrDefault(value, 0)) * 1000000;
  }

  function technicalForColorProfile(profile) {
    return profile === "action4-dlogm" ? "action4" : profile === "action5pro-dlogm" ? "action5pro" : profile === "action6-dlogm" ? "action6" : profile === "pocket3-dlogm" ? "pocket3" : profile === "pocket4-dlog" ? "pocket4" : profile === "pocket4p-dlog" ? "pocket4p" : profile === "osmo-nano-dlogm" ? "osmo-nano" : "none";
  }

  function colorProfileForTechnical(technical) {
    return technical === "action4" ? "action4-dlogm" : technical === "action5pro" ? "action5pro-dlogm" : technical === "action6" ? "action6-dlogm" : technical === "pocket3" ? "pocket3-dlogm" : technical === "pocket4" ? "pocket4-dlog" : technical === "pocket4p" ? "pocket4p-dlog" : technical === "osmo-nano" ? "osmo-nano-dlogm" : "normal";
  }

  function playbackStartTime({ currentTime, ended, sourceIn = 0, sourceOut = 0 }) {
    const current = numberOrDefault(currentTime, 0);
    const start = Math.max(0, numberOrDefault(sourceIn, 0));
    const end = Math.max(start, numberOrDefault(sourceOut, 0));
    return ended || (end > start && current >= end - 0.02) ? start : current;
  }

  function previewTimelineSeconds(currentTime, clip) {
    const sourceIn = numberOrDefault(clip && clip.sourceInUs, 0) / 1000000;
    const rate = Math.max(0.1, numberOrDefault(clip && clip.playbackRate, 1));
    return Math.max(0, (numberOrDefault(currentTime, 0) - sourceIn) / rate);
  }

  function exportDurationSeconds(clip, fallback = 0) {
    if (!clip) return Math.max(0, numberOrDefault(fallback, 0));
    const sourceSpan = Math.max(0, numberOrDefault(clip.sourceOutUs, 0) - numberOrDefault(clip.sourceInUs, 0)) / 1000000;
    return sourceSpan / Math.max(0.1, numberOrDefault(clip.playbackRate, 1));
  }

  function trimPlaybackState(currentTime, clip) {
    const current = numberOrDefault(currentTime, 0);
    const sourceIn = numberOrDefault(clip && clip.sourceInUs, 0) / 1000000;
    const sourceOut = numberOrDefault(clip && clip.sourceOutUs, 0) / 1000000;
    if (current < sourceIn) return { currentTime: sourceIn, shouldPause: false };
    if (sourceOut > sourceIn && current >= sourceOut - 0.01) return { currentTime: sourceOut, shouldPause: true };
    return { currentTime: current, shouldPause: false };
  }

  function displayResolution(asset) {
    const geometry = asset && asset.displayGeometry && asset.displayGeometry.original;
    const probe = asset && asset.original && asset.original.probe;
    const width = geometry && geometry.displayWidth !== "UNKNOWN" ? geometry.displayWidth : probe && probe.width;
    const height = geometry && geometry.displayHeight !== "UNKNOWN" ? geometry.displayHeight : probe && probe.height;
    return width && height && width !== "UNKNOWN" && height !== "UNKNOWN" ? String(width) + "x" + String(height) : "?";
  }

  function selectionInAssets(assets, assetId) {
    return !!assetId && Array.isArray(assets) && assets.some(asset => asset && asset.id === assetId);
  }

  function navigationState(assets, assetId) {
    const index = Array.isArray(assets) ? assets.findIndex(asset => asset && asset.id === assetId) : -1;
    return { previousDisabled: index <= 0, nextDisabled: index < 0 || index >= assets.length - 1 };
  }

  function assetControlState(asset, watermarkEnabled) {
    const editingDisabled = !asset || asset.mediaKind === "photo";
    return {
      editingDisabled,
      watermarkStyleDisabled: editingDisabled || !watermarkEnabled,
      watermarkPositionsDisabled: editingDisabled,
      exportDisabled: editingDisabled,
      exportAsHidden: editingDisabled
    };
  }

  function emptyStateFor({ totalCount, visibleCount, filter, isLocal }) {
    if (visibleCount > 0) return { hidden: true };
    if (totalCount > 0 && filter === "photos") return { hidden: false, titleKey: "filter.emptyPhotos", hintKey: "filter.emptyHint" };
    if (totalCount > 0 && filter === "videos") return { hidden: false, titleKey: "filter.emptyVideos", hintKey: "filter.emptyHint" };
    return { hidden: false, titleKey: isLocal ? "local.empty" : "media.scanPrompt", hintKey: isLocal ? "local.emptyHint" : "media.connectPrompt" };
  }

  function shouldRenderExportFacts(asset) {
    return !!asset && asset.mediaKind !== "photo";
  }

  function shouldResetSelectionOnSourceChange(currentSource, nextSource) {
    return typeof nextSource === "string" && currentSource !== nextSource;
  }

  function isExportCanceledError(error) {
    return /(?:^|:\s*)Export canceled\s*$/.test(String(error && error.message || error || ""));
  }

  const api = { numberOrDefault, watermarkFromControls, createSerialRunner, createLatestRunner, switchMode, snapshotItems, secondsFromMicroseconds, microsecondsFromSeconds, technicalForColorProfile, colorProfileForTechnical, playbackStartTime, previewTimelineSeconds, exportDurationSeconds, trimPlaybackState, displayResolution, selectionInAssets, navigationState, assetControlState, emptyStateFor, shouldRenderExportFacts, isExportCanceledError, shouldResetSelectionOnSourceChange };
  if (typeof window !== "undefined") window.__editorUiState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
