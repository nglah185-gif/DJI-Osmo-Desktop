const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("djiMedia", Object.freeze({
  scan: () => ipcRenderer.invoke("media:scan"),
  getSnapshot: () => ipcRenderer.invoke("media:snapshot"),
  getPreviewUrl: assetId => ipcRenderer.invoke("media:preview-url", assetId),
  getPreviewFallback: assetId => ipcRenderer.invoke("media:preview-fallback", assetId),
  getThumbnailUrl: (assetId, minWidth) => ipcRenderer.invoke("media:thumbnail-url", { assetId, minWidth }),
  getPosterUrl: assetId => ipcRenderer.invoke("media:poster-url", assetId),
  openEditor: assetId => ipcRenderer.invoke("editor:open", assetId),
  renderEditPreview: request => ipcRenderer.invoke("editor:preview-frame", request),
  renderPreviewStart: p => ipcRenderer.invoke("editor:preview-start", p),
  renderPreviewUpdate: p => ipcRenderer.invoke("editor:preview-update", p),
  renderPreviewSeek: p => ipcRenderer.invoke("editor:preview-seek", p),
  renderPreviewPause: p => ipcRenderer.invoke("editor:preview-pause", p),
  renderPreviewResume: p => ipcRenderer.invoke("editor:preview-resume", p),
  renderPreviewStop: p => ipcRenderer.invoke("editor:preview-stop", p),
  // Fire-and-forget clock feedback. send() rather than invoke() so a per-frame
  // report cannot add a round-trip to the playback path.
  reportPreviewClock: p => ipcRenderer.send("editor:preview-clock", p),
  exportEdit: request => ipcRenderer.invoke("editor:export", request),
  exportEditAs: request => ipcRenderer.invoke("editor:export-as", request),
  cancelExport: () => ipcRenderer.invoke("editor:export-cancel"),
  exportBatch: request => ipcRenderer.invoke("library:export-batch", request),
  batchSetup: request => ipcRenderer.invoke("library:batch-setup", request),
  cancelExportBatch: request => ipcRenderer.invoke("library:export-batch-cancel", request),
  revealPath: target => ipcRenderer.invoke("shell:reveal-path", target),
  getLocalSnapshot: () => ipcRenderer.invoke("library:local-snapshot"),
  addLocalFolder: () => ipcRenderer.invoke("library:add-folder"),
  importLocalFiles: () => ipcRenderer.invoke("library:import-files"),
  refreshLocalLibrary: () => ipcRenderer.invoke("library:refresh"),
  getLocalSources: () => ipcRenderer.invoke("library:sources"),
  removeLocalSource: source => ipcRenderer.invoke("library:remove-source", source),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: patch => ipcRenderer.invoke("settings:set", patch),
  chooseExportLocation: () => ipcRenderer.invoke("settings:choose-export-location"),
  onSnapshot: callback => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("media:snapshot-updated", listener);
    return () => ipcRenderer.removeListener("media:snapshot-updated", listener);
  },
  onLocalSnapshot: callback => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("library:local-snapshot-updated", listener);
    return () => ipcRenderer.removeListener("library:local-snapshot-updated", listener);
  },
  onScanProgress: callback => { if (typeof callback !== "function") return () => {}; const listener = (_event, progress) => callback(progress); ipcRenderer.on("media:scan-progress", listener); return () => ipcRenderer.removeListener("media:scan-progress", listener); },
  onPreviewProgress: callback => { if (typeof callback !== "function") return () => {}; const listener = (_event, progress) => callback(progress); ipcRenderer.on("media:preview-progress", listener); return () => ipcRenderer.removeListener("media:preview-progress", listener); },
  onPreviewFrame: callback => { if (typeof callback !== "function") return () => {}; const listener = (_event, frame) => callback(frame); ipcRenderer.on("preview:frame", listener); return () => ipcRenderer.removeListener("preview:frame", listener); },
  onPreviewError: callback => { if (typeof callback !== "function") return () => {}; const listener = (_event, error) => callback(error); ipcRenderer.on("preview:error", listener); return () => ipcRenderer.removeListener("preview:error", listener); },
  onPreviewEnded: callback => { if (typeof callback !== "function") return () => {}; const listener = (_event, details) => callback(details); ipcRenderer.on("preview:ended", listener); return () => ipcRenderer.removeListener("preview:ended", listener); },
  onExportProgress: callback => { if (typeof callback !== "function") return () => {}; const listener = (_event, progress) => callback(progress); ipcRenderer.on("export:progress", listener); return () => ipcRenderer.removeListener("export:progress", listener); },
  onExportBatchUpdate: callback => { if (typeof callback !== "function") return () => {}; const listener = (_event, items) => callback(items); ipcRenderer.on("export:batch-update", listener); return () => ipcRenderer.removeListener("export:batch-update", listener); }
}));
