(() => {
  // Setup state for the batch export dialog. The dialog opens before any work
  // starts so the decisions that materially change the output can be made first:
  // what happens to colour, and whether a watermark is burned in. Everything here
  // is plain data so the decisions and labels stay unit tested; DOM wiring lives
  // in renderer-phase3.js.
  //
  // The clip list and the watermark choices are supplied by the main process,
  // not derived here. Detection has exactly one implementation and this state
  // must not invent a second opinion about which clips are D-Log.
  //
  // Colour leads with "auto", which is the detector. The manual entries exist
  // because detection can only read what the file carries: a clip that was
  // re-muxed, trimmed by another tool or written by a camera whose metadata this
  // build does not know comes back as "unknown", and the export would then copy
  // log footage without restoring it.

  const COLOR_AUTO = "auto";
  const COLOR_NONE = "none";
  // The transform ids the graph builder understands. Anything else is treated as
  // "auto" rather than passed through, so a stale renderer cannot ask for a
  // filter that does not exist.
  const COLOR_TRANSFORMS = ["action4", "action5pro", "action6", "pocket3", "pocket4", "pocket4p", "osmo-nano"];

  function normalizeColorMode(value) {
    const text = String(value || "");
    if (text === COLOR_NONE) return COLOR_NONE;
    if (COLOR_TRANSFORMS.includes(text)) return text;
    return COLOR_AUTO;
  }

  function initialState({ clips = [], watermarks = [], destination = "", skipped = 0, colorMode = COLOR_AUTO, watermarkEnabled = false, watermarkId = null } = {}) {
    const list = (Array.isArray(clips) ? clips : []).map(clip => ({
      assetId: String(clip && clip.assetId || ""),
      name: String(clip && clip.name || ""),
      kind: clip && clip.kind === "photo" ? "photo" : "video",
      needsRestore: clip && clip.needsRestore === true
    }));
    const choices = (Array.isArray(watermarks) ? watermarks : [])
      .map(entry => ({ id: String(entry && entry.id || ""), name: String(entry && entry.name || "") }))
      .filter(entry => entry.id);
    // Asking for a watermark with nothing to choose from would render a checked
    // box that burns in nothing, so the option only exists when a badge does.
    const enabled = watermarkEnabled === true && choices.length > 0;
    const chosen = watermarkId && choices.some(entry => entry.id === watermarkId) ? String(watermarkId) : (choices[0] ? choices[0].id : "");
    return {
      clips: list,
      watermarks: choices,
      destination: String(destination || ""),
      skipped: Math.max(0, Number(skipped) || 0),
      colorMode: normalizeColorMode(colorMode),
      watermarkEnabled: enabled,
      watermarkId: chosen
    };
  }

  function setColorMode(state, value) {
    const colorMode = normalizeColorMode(value);
    return colorMode === state.colorMode ? state : { ...state, colorMode };
  }

  function setWatermarkEnabled(state, value) {
    const enabled = value === true && state.watermarks.length > 0;
    return enabled === state.watermarkEnabled ? state : { ...state, watermarkEnabled: enabled };
  }

  function setWatermarkId(state, value) {
    const id = String(value || "");
    if (!state.watermarks.some(entry => entry.id === id)) return state;
    return id === state.watermarkId ? state : { ...state, watermarkId: id };
  }

  function isManual(mode) { return COLOR_TRANSFORMS.includes(normalizeColorMode(mode)); }

  // How many clips the current answer will actually touch. A still has no colour
  // pipeline, so it never counts.
  function restoreCount(state) {
    const manual = isManual(state.colorMode);
    return state.clips.reduce((total, clip) => {
      if (clip.kind === "photo") return total;
      if (manual) return total + 1;
      return total + (state.colorMode === COLOR_NONE || !clip.needsRestore ? 0 : 1);
    }, 0);
  }

  // The label the headline and the per-row tags read. Detection is still what
  // decided `needsRestore`; this only says what will be done about it.
  function transformKeyFor(mode) {
    const normalized = normalizeColorMode(mode);
    if (normalized === COLOR_AUTO) return "batchExport.colorAuto";
    if (normalized === COLOR_NONE) return "batchExport.colorNone";
    return "color." + (normalized === "action4" ? "action4Rec709" : normalized === "action5pro" ? "action5proRec709" : normalized === "action6" ? "action6Rec709" : normalized === "pocket3" ? "pocket3Rec709" : normalized === "pocket4" ? "pocket4Rec709" : normalized === "pocket4p" ? "pocket4pRec709" : "osmoNanoRec709");
  }

  function view(state) {
    const total = state.clips.length;
    const manual = isManual(state.colorMode);
    const detected = state.clips.reduce((count, clip) => count + (clip.kind !== "photo" && clip.needsRestore ? 1 : 0), 0);
    const restoreCountValue = restoreCount(state);
    let headlineKey = "batchExport.noRestore";
    if (state.colorMode === COLOR_AUTO) headlineKey = detected > 0 ? "batchExport.needsRestore" : "batchExport.noRestore";
    else if (manual) headlineKey = "batchExport.manualRestore";
    return {
      total,
      skipped: state.skipped,
      destination: state.destination,
      colorMode: state.colorMode,
      colorModeKey: transformKeyFor(state.colorMode),
      manual,
      restore: state.colorMode !== COLOR_NONE,
      needsRestore: detected,
      restoreCount: restoreCountValue,
      headlineKey,
      headlineParams: { count: restoreCountValue, model: "" },
      watermarkEnabled: state.watermarkEnabled,
      watermarkId: state.watermarkId,
      // A change to this signature means the <option> set changed, which is the
      // only time the select has to be rebuilt.
      watermarkSignature: state.watermarks.map(entry => entry.id).join(","),
      watermarks: state.watermarks,
      // The shape the export IPC expects, or null when the option is off.
      watermark: state.watermarkEnabled ? { enabled: true, id: state.watermarkId, scale: 0.195, opacity: 1, position: { x: 0.5, y: 1 } } : null,
      startDisabled: total === 0,
      clips: state.clips.map(clip => ({
        assetId: clip.assetId,
        name: clip.name,
        isPhoto: clip.kind === "photo",
        // The tag only claims restoration when restoration will happen for that
        // row, so the list and the choice can never contradict each other.
        showRestore: clip.kind !== "photo" && (manual || (state.colorMode !== COLOR_NONE && clip.needsRestore))
      }))
    };
  }

  const api = { COLOR_AUTO, COLOR_NONE, COLOR_TRANSFORMS, normalizeColorMode, isManual, transformKeyFor, initialState, setColorMode, setWatermarkEnabled, setWatermarkId, restoreCount, view };
  if (typeof window !== "undefined") window.__batchExportOptions = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
