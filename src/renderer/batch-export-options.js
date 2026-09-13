(() => {
  // Setup state for the batch export dialog. The dialog opens before any work
  // starts so the two decisions that materially change the output can be made
  // first: whether D-Log clips are restored, and whether a watermark is burned
  // in. Everything here is plain data so the decisions and labels stay unit
  // tested; DOM wiring lives in renderer-phase3.js.
  //
  // The clip list and the watermark choices are supplied by the main process,
  // not derived here. Detection has exactly one implementation and this state
  // must not invent a second opinion about which clips are D-Log.

  function initialState({ clips = [], watermarks = [], destination = "", skipped = 0, restore = true, watermarkEnabled = false, watermarkId = null } = {}) {
    const list = (Array.isArray(clips) ? clips : []).map(clip => ({
      assetId: String(clip && clip.assetId || ""),
      name: String(clip && clip.name || ""),
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
      restore: restore !== false,
      watermarkEnabled: enabled,
      watermarkId: chosen
    };
  }

  function setRestore(state, value) {
    const restore = value !== false;
    return restore === state.restore ? state : { ...state, restore };
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

  // How many clips the current answer will actually touch. The per-row tag uses
  // needsRestore so it can disappear when restoration is switched off; the
  // option hint uses restoreCount so "3 will be restored" tracks the toggle.
  function restoreCount(state) {
    return state.clips.reduce((total, clip) => total + (clip.needsRestore ? 1 : 0), 0);
  }

  function view(state) {
    const total = state.clips.length;
    const needsRestore = restoreCount(state);
    return {
      total,
      skipped: state.skipped,
      destination: state.destination,
      restore: state.restore,
      needsRestore,
      restoreCount: state.restore ? needsRestore : 0,
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
        // The tag only claims restoration while restoration is still on, so the
        // row and the checkbox can never contradict each other.
        showRestore: clip.needsRestore && state.restore
      }))
    };
  }

  const api = { initialState, setRestore, setWatermarkEnabled, setWatermarkId, restoreCount, view };
  if (typeof window !== "undefined") window.__batchExportOptions = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
