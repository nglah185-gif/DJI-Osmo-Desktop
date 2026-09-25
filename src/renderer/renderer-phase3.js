(() => {
  const api = window.djiMedia;
  const ts = window.i18n && window.i18n.t ? (k, v) => window.i18n.t(k, v) : (k, v) => k;
  const $ = id => document.getElementById(id);
  const { computeWindow, computePrefetchRange, columnsFor } = window.__vGrid;
  const { sortAssets } = window.__sort;
  const { clampTimeToRange, trimFromEvent } = window.__timelineMath;
  const timelineModel = window.__timelineEditModel;
  const editorUiState = window.__editorUiState;
  const exportModalState = window.__exportModalState;
  const batchExportState = window.__batchExportState;
  const batchOptionsState = window.__batchExportOptions;
  const videoOptionsState = window.__videoExportOptions;
  const badgePicker = window.__badgePicker;
  // Shared with the main process so the editor and a batch agree on which clips
  // are D-Log and which camera transform each needs.
  const autoRestore = window.__autoRestore;
  const iconSet = window.__icons;
  const ThumbScheduler = window.__ThumbScheduler;
  const WM_POSITIONS = { topLeft: { x: 0, y: 0 }, topRight: { x: 1, y: 0 }, center: { x: 0.5, y: 0.5 }, bottomLeft: { x: 0, y: 1 }, bottomCenter: { x: 0.5, y: 1 }, bottomRight: { x: 1, y: 1 } };
  const EDIT_CONTROL_IDS = ["color-profile", "technical-transform", "creative-look", "trim-in", "trim-out", "speed", "rotate", "crop", "flip-h", "flip-v", "watermark", "watermark-scale", "watermark-opacity", "watermark-enable"];
  const state = { snapshot: null, localSnapshot: null, source: "camera", settings: {}, asset: null, editor: null, mode: "browse", filter: "all", nav: "browse", sort: "latest", view: "poster", wmPosition: "bottomCenter", timelineZoom: 1, selectedSegmentId: null };
  const video = $("preview-video"), image = $("color-preview"), canvas = $("preview-canvas"), grid = $("media-list") || $("media-grid"), error = $("error-banner"), errorMessage = $("error-message"), retryPreview = $("preview-retry");
  // Card geometry per view. Each entry must stay in step with the matching
  // .media-card rules in styles.css: the grid positions cards by arithmetic and
  // never measures them, so a mismatch shows up as overlapping or floating rows
  // rather than as an error.
  //
  //   list    metadata-led. Read durations, codecs and frame rates down a column.
  //   poster  picture-led. Find the clip you want.
  //
  // Poster is the default: this is a media browser, and 411 clips in a 116px
  // thumbnail column is not a way to find anything.
  const VIEWS = {
    list: { itemH: 100, cardW: 320, gap: 10 },
    poster: { itemH: 216, cardW: 248, gap: 12 }
  };
  const LEFT = 12, PREFETCH_AFTER = 20, NODE_LIMIT = 320;
  const viewGeometry = () => VIEWS[state.view] || VIEWS.poster;
  // How many cards fit across the list at its current width. Read from the
  // element rather than tracked in state so a window resize or a layout change
  // (the library widens when no clip is open) needs no extra bookkeeping.
  const gridColumns = () => { const view = viewGeometry(); return columnsFor(grid.clientWidth, view.cardW, view.gap); };
  const ICON_PLAY = iconSet.get("play");
  const ICON_PAUSE = iconSet.get("pause");
  const fmtClock = value => { const s = Math.max(0, Number(value) || 0); const m = Math.floor(s / 60); const sec = s - m * 60; return String(m).padStart(2, "0") + ":" + sec.toFixed(3).padStart(6, "0"); };
  const fmtDuration = value => { const s = Math.max(0, Number(value) || 0); const m = Math.floor(s / 60); const sec = Math.floor(s % 60); return String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0"); };
  const showError = (message, retry = false) => { error.hidden = false; if (errorMessage) errorMessage.textContent = ts("error.prefix") + message; else error.textContent = ts("error.prefix") + message; if (retryPreview) { retryPreview.hidden = !retry; retryPreview.textContent = ts("preview.retry"); } };
  const fail = e => showError(e.message || String(e), false);
  const hideError = () => { error.hidden = true; if (retryPreview) retryPreview.hidden = true; };
  const presetFor = (colorProfile, technical, look) => { if (look) return look; if (colorProfile === "action4-dlogm" || technical === "action4") return "action4-dlogm"; if (colorProfile === "action5pro-dlogm" || technical === "action5pro") return "action5pro-dlogm"; if (colorProfile === "action6-dlogm" || technical === "action6") return "action6-dlogm"; return "normal"; };
  function activeAssets() { const list = state.source === "local" ? (state.localSnapshot ? state.localSnapshot.assets : []) : (state.snapshot ? state.snapshot.assets : []); if (state.filter === "photos") return sortAssets(list.filter(asset => asset.mediaKind === "photo"), state.sort); if (state.filter === "videos") return sortAssets(list.filter(asset => asset.mediaKind !== "photo"), state.sort); return sortAssets(list, state.sort); }
  function deviceDisplayName(device) {
    if (!device) return "";
    const friendlyNames = device.evidence && Array.isArray(device.evidence.pnpFriendlyNames) ? device.evidence.pnpFriendlyNames : [];
    const friendly = friendlyNames.find(name => /Osmo|Action|DJI/i.test(String(name)) && !/^BULK Interface$/i.test(String(name)));
    return friendly || (device.cameraModel && device.cameraModel !== "UNKNOWN" ? device.cameraModel : "");
  }

  const scheduler = new ThumbScheduler({ concurrency: 3 });
  function withTimeout(promise, timeoutMs, message) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
  let visibleCount = 0, paintQueued = false, editTimer = null, openToken = 0, editRequestId = 0, exportingAssetId = null;
  const runEditOperation = editorUiState.createLatestRunner();
  const schedulePaint = () => { if (paintQueued) return; paintQueued = true; requestAnimationFrame(() => { paintQueued = false; if (grid.isConnected) paintGrid(); }); };
  const PreviewCanvasSurface = window.__PreviewCanvasSurface;
  const canvasSurface = PreviewCanvasSurface ? PreviewCanvasSurface.create(canvas) : null;
  let latestPreviewFrame = null, previewFrameDirty = false, previewRaf = 0, previewEntryPaused = false, previewPaintQueued = false;
let pendingEarlyFrame = null;
// Guards the end-of-source relaunch path. A source whose tail always fails to
// decode must settle on the last good frame instead of respawning ffmpeg in a loop.
let previewEndedRestarts = 0;
const PREVIEW_ENDED_RESTART_LIMIT = 3;
const previewClock = window.__previewClock;
const PREVIEW_SKEW_TOLERANCE = previewClock.PREVIEW_SKEW_TOLERANCE;
// Timestamp of the last decoder resync, used to rate limit recovery.
let lastPreviewResyncAt = 0;
// ffmpeg needs a few hundred ms to spawn and emit its first processed frame,
// but the hidden video is the audio clock and would otherwise run that whole
// time. The result is audible: the original ungraded image plays, the canvas
// takes over late, and the picture then trails the audio by the spawn cost for
// the rest of the clip. Hold the clock across every relaunch instead, so audio
// and processed frames begin together and no offset is ever created.
//
// The holds are issued programmatically, and `pause`/`play` fire asynchronously
// in the browser, so a flag cleared in a `finally` would already be stale by the
// time the handler runs. Count the suppressions and let each handler consume one.
let suppressPauseIpc = 0, suppressPlayIpc = 0;
// True while the clock is held only because a launch is in flight. The frame
// handler must be able to tell this apart from a genuinely paused player: the
// paused state otherwise reads as "the user entered while paused" and pauses the
// decoder we are waiting on, killing the pipe and freezing the canvas.
let clockHeldForLaunch = false;
function pauseClockSilently() {
  if (video.paused) return false;
  suppressPauseIpc += 1;
  clockHeldForLaunch = true;
  video.pause();
  return true;
}
function playClockSilently() {
  clockHeldForLaunch = false;
  if (!video.paused) return;
  suppressPlayIpc += 1;
  const started = video.play();
  // A rejected play() never emits `play`, so the suppression would leak and
  // swallow the user's next genuine resume.
  if (started && typeof started.catch === "function") started.catch(() => { if (suppressPlayIpc > 0) suppressPlayIpc -= 1; });
}
  // Measures the constant lag ffmpeg's startup imposes on the pipe so late
  // frames are judged against the pipe's own baseline instead of being dropped
  // forever. Reset wherever the pipe restarts, since the lag is remeasured then.
  const previewLag = previewClock.createLagTracker();
  const previewGenerationWaiters = new Set();
  function waitForPreviewGeneration(assetId, launchGeneration, timeoutMs = 8000, isCurrent = null) {
    const generation = Number(launchGeneration || 0);
    if (!generation) return Promise.resolve();
    if (isCurrent && !isCurrent()) return Promise.resolve();
    if (latestPreviewFrame && latestPreviewFrame.assetId === assetId && Number(latestPreviewFrame.launchGeneration || 0) >= generation) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { assetId, generation, isCurrent, resolve: () => { clearTimeout(waiter.timer); previewGenerationWaiters.delete(waiter); resolve(); } };
      waiter.timer = setTimeout(() => { previewGenerationWaiters.delete(waiter); reject(new Error(ts("preview.timeout"))); }, timeoutMs);
      previewGenerationWaiters.add(waiter);
    });
  }
  function releaseObsoletePreviewWaiters() {
    for (const waiter of [...previewGenerationWaiters]) if (waiter.isCurrent && !waiter.isCurrent()) waiter.resolve();
  }
  function notifyPreviewGeneration(frame) {
    const generation = Number(frame && frame.launchGeneration || 0);
    for (const waiter of [...previewGenerationWaiters]) if (waiter.assetId === frame.assetId && generation >= waiter.generation) waiter.resolve();
  }
  function releasePendingEarlyFrame() {
  // A frame held back for being ahead of the audio clock is released once the
  // clock reaches it. Without this the canvas would freeze on the last in-window
  // frame instead of resuming in sync.
  if (!pendingEarlyFrame || state.mode !== "edit") return;
  if (!previewClock.shouldReleaseHeldFrame({
    frameSourceTime: pendingEarlyFrame.sourceTime,
    clockSourceTime: video.currentTime,
    lagOffset: previewLag.offset,
    // Same reasoning as frameDecision: a launch hold is not a resting pause, so
    // it must not unconditionally release a frame that is still ahead.
    paused: video.paused && !clockHeldForLaunch
  })) return;
  latestPreviewFrame = pendingEarlyFrame; previewFrameDirty = true; pendingEarlyFrame = null;
}
  let lastReportedClock = -1;
  // Feed the hidden video's position back to the frame streamer so it can stop
  // decoding ahead of the display clock. Reported from the paint loop because
  // that is the same clock the frame decisions above are made against.
  // A relaunch clears the streamer's stored clock. The de-dup sentinel below is
  // process-global, so without this reset a paused clock whose value has not
  // changed would never be re-reported and the gate would stay open-loop.
  function invalidateReportedClock() { lastReportedClock = -1; }
  function reportPreviewClock() {
    if (state.mode !== "edit" || !state.asset || state.asset.mediaKind === "photo") return;
    if (!api.reportPreviewClock) return;
    const clockSourceTime = video.currentTime;
    if (!Number.isFinite(clockSourceTime) || clockSourceTime === lastReportedClock) return;
    lastReportedClock = clockSourceTime;
    api.reportPreviewClock({ assetId: state.asset.id, clockSourceTime });
  }
  function paintLatestPreview() {
    reportPreviewClock();
    releasePendingEarlyFrame();
    if (previewFrameDirty && latestPreviewFrame && canvasSurface && state.mode === "edit") { canvasSurface.paint(latestPreviewFrame); previewFrameDirty = false; }
    // A frame still held back needs another tick to be re-checked. ffmpeg is rate
    // limited and may send nothing further, so this self-sustaining retry is the
    // only thing that gets the held frame on screen.
    if (pendingEarlyFrame && state.mode === "edit") queuePreviewPaint();
  }
  function queuePreviewPaint() {
    if (previewPaintQueued) return;
    previewPaintQueued = true;
    const paint = () => { previewPaintQueued = false; paintLatestPreview(); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(paint);
    else setTimeout(paint, 16);
  }
  function startPreviewLoop() { if (previewRaf) return; const loop = () => { paintLatestPreview(); previewRaf = requestAnimationFrame(loop); }; previewRaf = requestAnimationFrame(loop); }
  function stopPreviewLoop() { if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = 0; } }
  const scheduleEdit = () => { const requestId = ++editRequestId; releaseObsoletePreviewWaiters(); clearTimeout(editTimer); editTimer = setTimeout(() => { runEditOperation(async () => { if (!state.asset || state.asset.mediaKind === "photo") return; const assetId = state.asset.id; const editor = editorFromControls(); state.editor = editor; renderExportFacts(); const isCurrent = () => requestId === editRequestId && state.asset && state.asset.id === assetId && state.mode === "edit"; try { if (state.mode !== "edit") { await setMode("edit"); } else { syncVideoClock(editor); previewEntryPaused = video.paused; setStateBadge(ts("preview.applying"), false, "preview.applying"); const request = { assetId, timelineSeconds: previewTimelineSeconds(editor), editor }; let result = await withTimeout(api.renderPreviewUpdate(request), 8000, ts("preview.timeout")); if (!result || result.updated === false) result = await withTimeout(api.renderPreviewStart(request), 8000, ts("preview.timeout")); await waitForPreviewGeneration(assetId, result && result.launchGeneration, 8000, isCurrent); if (isCurrent()) setStateBadge(ts("preview.liveEffects"), true, "preview.liveEffects"); } } catch (e) { if (isCurrent()) { try { await withTimeout(api.renderPreviewStop({ assetId }), 3000, ts("preview.timeout")); } catch {} if (e && e.message === ts("preview.timeout")) showError(e.message, true); else fail(e); setStateBadge("", false); } } }); }, 130); };
  function renderStats() { const s = scheduler.snapshot(); $("thumb-stats").textContent = "Visible: " + visibleCount + " · Requested: " + s.requested + " · Loading: " + s.loading + " · Loaded: " + s.loaded + " · Cache Hit: " + s.cacheHit + " · Error: " + s.error; }
  // Thumbnail cache, keyed by asset AND size tier. The camera supplies a 160x90
  // THM and a 1280x720 SCR for the same clip; the list draws 116x72 tiles from
  // the small one and the poster grid needs the large one. Keying by asset alone
  // served whichever was generated first, which is how the poster tiles ended up
  // upscaling a 160px image.
  const thumbCache = new Map();
  const THUMB_TIERS = { list: 116, poster: 231 };
  const thumbMinWidth = () => THUMB_TIERS[state.view] || THUMB_TIERS.poster;
  const thumbKey = assetId => assetId + "@" + thumbMinWidth();
  function enqueueThumbnail(assetId, thumb, priority) { const key = thumbKey(assetId); const task = () => api.getThumbnailUrl(assetId, thumbMinWidth()).then(result => { if (!result) { if (thumb.isConnected) thumb.replaceChildren(makePlaceholder()); return {}; } const url = result.url || result; thumbCache.set(key, url); const img = new Image(); img.onload = () => { if (thumb.isConnected) thumb.replaceChildren(img); }; img.onerror = () => { if (thumb.isConnected) thumb.replaceChildren(makePlaceholder()); }; img.src = url; if (!thumb.isConnected) schedulePaint(); return { cacheHit: !!result.cacheHit }; }).catch(() => { if (thumb.isConnected) thumb.replaceChildren(makePlaceholder()); return {}; }).finally(renderStats); task.priority = priority; task.token = key; scheduler.enqueue(task); renderStats(); }
  function prefetchThumbnail(assetId) { const key = thumbKey(assetId); const task = () => api.getThumbnailUrl(assetId, thumbMinWidth()).then(result => { if (!result) return {}; const url = result.url || result; thumbCache.set(key, url); const img = new Image(); img.src = url; renderStats(); return { cacheHit: !!result.cacheHit }; }).catch(() => ({})).finally(renderStats); task.priority = 0; task.token = key; scheduler.enqueue(task); }
  function makePlaceholder() { const el = document.createElement("span"); el.className = "thumb-placeholder"; el.dataset.i18n = "media.noThumbnail"; el.textContent = ts("media.noThumbnail"); return el; }

  function renderSurface(snapshot, isLocal) {
    hideError();
    const assets = editorUiState.snapshotItems(snapshot, "assets");
    const devices = editorUiState.snapshotItems(snapshot, "devices");
    const filesLabel = document.createElement("span"); filesLabel.dataset.i18n = "scan.filesLabel"; filesLabel.textContent = ts("scan.filesLabel");
    $("scan-files").replaceChildren(document.createTextNode(String(assets.length) + " "), filesLabel);
    $("count-all").textContent = String(assets.length);
    $("count-videos").textContent = String(assets.filter(asset => asset.mediaKind !== "photo").length);
    $("count-photos").textContent = String(assets.filter(asset => asset.mediaKind === "photo").length);
    renderEmptyState(snapshot, isLocal);
    const detectedDevice = devices.find(d => d.status === "POSSIBLE_DJI_STORAGE") || devices.find(d => deviceDisplayName(d));
    $("device-title").textContent = isLocal ? ts("src.local") : (deviceDisplayName(detectedDevice) || ts("app.noDevice"));
    const scanErrors = editorUiState.snapshotItems(snapshot, "errors");
    if (isLocal && scanErrors.length) showError(ts("local.scanIssues", { count: scanErrors.length, message: scanErrors[0].message || scanErrors[0].path || ts("color.unknown") }), false);
  }
  function renderEmptyState(snapshot, isLocal) {
    const assets = editorUiState.snapshotItems(snapshot, "assets");
    const result = editorUiState.emptyStateFor({ totalCount: assets.length, visibleCount: activeAssets().length, filter: state.filter, isLocal });
    const empty = $("empty-state");
    empty.hidden = result.hidden;
    if (!result.hidden) { const title = empty.querySelector("h2"), hint = empty.querySelector("p"); title.dataset.i18n = result.titleKey; hint.dataset.i18n = result.hintKey; title.textContent = ts(result.titleKey); hint.textContent = ts(result.hintKey); }
  }
  function currentSnapshot() { return state.source === "local" ? state.localSnapshot : state.snapshot; }
  function updateNavigation() {
    const navigation = editorUiState.navigationState(activeAssets(), state.asset && state.asset.id);
    $("btn-prev").disabled = navigation.previousDisabled;
    $("btn-next").disabled = navigation.nextDisabled;
  }
  function setAssetControls(asset) {
    const controlState = editorUiState.assetControlState(asset, $("watermark-enable").checked);
    document.body.classList.toggle("photo-mode", !!asset && asset.mediaKind === "photo");
    // Drives the whole inspector layout. See the gating rules in styles.css:
    // without a clip the colour pipeline and the timeline are inert, so the
    // panel reports on the library instead of showing dead controls.
    document.body.classList.toggle("has-clip", !!asset);
    renderLibraryPanel();
    // That class change resizes the media list, so the number of cards that fit
    // across it changes too. The card layout is arithmetic and never measured,
    // so it has to be recomputed rather than reflowed by the browser.
    schedulePaint();
    EDIT_CONTROL_IDS.forEach(controlId => { const control = $(controlId); if (control) control.disabled = controlId === "watermark" ? controlState.watermarkStyleDisabled : controlState.editingDisabled; });
    $("export-button").disabled = controlState.exportDisabled || !!exportingAssetId;
    $("export-as-button").disabled = controlState.exportDisabled || !!exportingAssetId;
    $("export-as-button").hidden = controlState.exportAsHidden;
    updateNavigation();
    syncModeControls();
  }
  function clearSelection() {
    const previous = state.asset;
    openToken++; editRequestId++;
    if (exportingAssetId) { try { api.cancelExport(); } catch {} }
    releaseObsoletePreviewWaiters();
    clearTimeout(editTimer);
    state.asset = null; state.editor = null; state.mode = "browse";
    previewToken++; fallbackArmed = false; rotatedSourceArmed = false;
    stopPreviewLoop(); previewEntryPaused = false; clockHeldForLaunch = false; latestPreviewFrame = null; previewFrameDirty = false; pendingEarlyFrame = null; previewLag.reset(); previewEndedRestarts = 0;
    if (previous) { try { api.renderPreviewStop({ assetId: previous.id }); } catch {} }
    video.pause(); video.removeAttribute("src"); video.load(); video.hidden = false; video.classList.remove("rotated", "rotated-apply"); video.style.transform = "";
    for (const surface of [$("poster-preview"), image]) { surface.removeAttribute("src"); surface.hidden = true; }
    canvas.hidden = true; if (canvasSurface) canvasSurface.clear();
    resetPreviewZoom(); hideGenerating(); setEmptyIcon(false); hideError(); setStateBadge("", false);
    $("video-empty").hidden = false; $("video-empty-text").textContent = ts("preview.select");
    if ($("timeline-thumbnails")) $("timeline-thumbnails").style.backgroundImage = "";
    $("proxy-label").textContent = ""; $("preview-debug").textContent = "Mode: BROWSE | Source: - | Type: -";
    $("export-facts").replaceChildren(); $("export-status").textContent = ""; $("export-progress").hidden = true; $("color-detect-hint").hidden = true;
    $("play-button").disabled = true; drawPlayer(); setAssetControls(null);
  }
  function reconcileSelection() {
    if (state.asset) {
      const current = activeAssets().find(asset => asset.id === state.asset.id);
      if (!current) { clearSelection(); return; }
      state.asset = current;
    }
    updateNavigation();
  }
  function render(snapshot) { state.snapshot = snapshot; if (state.source === "camera") { reconcileSelection(); renderSurface(snapshot, false); paintGrid(); } }
  function renderLocal(snapshot) { state.localSnapshot = snapshot; if (state.source === "local") { reconcileSelection(); renderSurface(snapshot, true); paintGrid(); } }
  function setSource(source) {
    if (editorUiState.shouldResetSelectionOnSourceChange(state.source, source) && state.asset) clearSelection();
    openToken++;
    state.source = source;
    document.querySelectorAll("[data-source]").forEach(b => b.classList.toggle("active", b.dataset.source === source));
    $("local-actions").hidden = source !== "local";
    $("rescan-button").hidden = source !== "camera";
    const snapshot = source === "local" ? state.localSnapshot : state.snapshot;
    reconcileSelection();
    renderSurface(snapshot || { assets: [], devices: [] }, source === "local");
    paintGrid();
  }
  document.querySelectorAll("[data-source]").forEach(b => b.addEventListener("click", () => setSource(b.dataset.source)));
  const localActionIds = ["add-folder-button", "import-files-button", "refresh-local-button", "manage-local-button"];
  function setLocalBusy(busy) { localActionIds.forEach(id => { const button = $(id); if (button) button.disabled = !!busy; }); }
  async function runLocalAction(action) {
    setLocalBusy(true); setScanStatus("scan.running");
    try { const snapshot = await action(); renderLocal(snapshot); setScanStatus("scan.completed"); return snapshot; }
    catch (errorValue) { scanFailed(errorValue); return null; }
    finally { setLocalBusy(false); }
  }
  $("add-folder-button").addEventListener("click", () => runLocalAction(() => api.addLocalFolder()));
  $("import-files-button").addEventListener("click", () => runLocalAction(() => api.importLocalFiles()));
  $("refresh-local-button").addEventListener("click", () => runLocalAction(() => api.refreshLocalLibrary()));

  const sourceOverlay = $("local-sources-overlay"), sourceList = $("local-source-list");
  function renderLocalSources(sources) {
    sourceList.replaceChildren();
    const rows = [
      ...(sources && Array.isArray(sources.folders) ? sources.folders.map(sourcePath => ({ kind: "folder", path: sourcePath })) : []),
      ...(sources && Array.isArray(sources.files) ? sources.files.map(sourcePath => ({ kind: "file", path: sourcePath })) : [])
    ];
    if (!rows.length) { const empty = document.createElement("div"); empty.className = "source-empty"; empty.dataset.i18n = "local.noSources"; empty.textContent = ts("local.noSources"); sourceList.appendChild(empty); return; }
    for (const source of rows) {
      const row = document.createElement("div"); row.className = "source-row";
      const kind = document.createElement("span"); kind.className = "source-kind"; kind.textContent = source.kind === "folder" ? "▰" : "▤"; kind.setAttribute("aria-hidden", "true");
      const sourcePath = document.createElement("span"); sourcePath.className = "source-path"; sourcePath.textContent = source.path; sourcePath.title = source.path;
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "source-remove"; remove.innerHTML = iconSet.get("close"); remove.dataset.i18nTitle = "local.remove"; remove.dataset.i18nAriaLabel = "local.remove"; remove.title = ts("local.remove"); remove.setAttribute("aria-label", ts("local.remove"));
      remove.addEventListener("click", async () => {
        remove.disabled = true; setLocalBusy(true);
        try { const result = await api.removeLocalSource(source); renderLocal(result.snapshot); renderLocalSources(result.sources); }
        catch (errorValue) { fail(errorValue); remove.disabled = false; }
        finally { setLocalBusy(false); }
      });
      row.append(kind, sourcePath, remove); sourceList.appendChild(row);
    }
  }
  $("manage-local-button").addEventListener("click", async () => { setLocalBusy(true); try { renderLocalSources(await api.getLocalSources()); sourceOverlay.hidden = false; } catch (errorValue) { fail(errorValue); } finally { setLocalBusy(false); } });
  $("local-sources-close").addEventListener("click", () => { sourceOverlay.hidden = true; });
  sourceOverlay.addEventListener("click", event => { if (event.target === sourceOverlay) sourceOverlay.hidden = true; });

  const cardNodes = new Map();
  // Batch selection lives beside, not inside, the open-a-clip action: clicking
  // the card body still opens the editor, and only the checkbox toggles export
  // membership. The card is a div rather than a button because an interactive
  // element cannot legally nest inside a button.
  const batchIds = new Set();
  // Single refresh point for everything that reflects the selection: the
  // floating bar over the list and the library block in the inspector. Both
  // show the same number, so they are always repainted together.
  function paintSelectionBar() {
    const bar = $("selection-bar");
    if (bar) {
      bar.hidden = batchIds.size === 0;
      const count = $("selection-count");
      if (count) count.textContent = ts("batchExport.selected", { count: batchIds.size });
    }
    renderLibraryPanel();
    paintSelectAllControl();
  }
  function toggleBatchSelection(assetId) {
    if (batchIds.has(assetId)) batchIds.delete(assetId); else batchIds.add(assetId);
    paintSelectionBar();
    paintGrid();
  }
  function clearBatchSelection() {
    if (!batchIds.size) return;
    batchIds.clear();
    paintSelectionBar();
    paintGrid();
  }
  // The inspector's library block. It answers the two questions that actually
  // matter while browsing — what is selected, and where will it go — and offers
  // the batch actions. It deliberately does not repeat the file/video/photo
  // counts, which the filter row above the list already shows.
  function renderLibraryPanel() {
    const stats = $("library-stats");
    if (!stats) return;
    const dt = document.createElement("dt"); dt.textContent = ts("library.statSelected");
    const dd = document.createElement("dd"); dd.textContent = String(batchIds.size);
    stats.replaceChildren(dt, dd);
    const destination = $("library-destination");
    if (destination) {
      const value = state.settings && state.settings.exportLocation ? state.settings.exportLocation : "";
      destination.textContent = value || ts("color.unknown");
      destination.title = value;
    }
    const exportButton = $("library-export-selected");
    if (exportButton) exportButton.disabled = batchIds.size === 0 || !!exportingAssetId;
  }
  // Selecting the whole view at a time. Clips and photos are both exportable --
  // they just take different paths through the pipeline -- so "all" means every
  // row the user can see.
  //
  // It is a toggle: once everything exportable is selected, a second press
  // clears it, so a mis-click is undone without hunting for Clear.
  function toggleSelectAll() {
    editorUiState.toggleSelectAll(activeAssets(), batchIds);
    paintSelectionBar();
    paintGrid();
  }
  // The list toolbar and the inspector each carry a select-all control, and both
  // read the same view, so they always agree on the label and on whether they
  // can be used at all (a Photos filter has nothing to offer batch export).
  function paintSelectAllControl(assets = activeAssets()) {
    const model = editorUiState.selectAllState(assets, batchIds);
    const label = ts(model.allSelected ? "batchExport.selectNone" : "batchExport.selectAll");
    for (const id of ["selection-all", "library-select-all"]) {
      const button = $(id);
      if (!button) continue;
      button.disabled = !model.enabled;
      button.textContent = label;
    }
  }
  function createCard(asset, priority) {
    // A div with role=button rather than a real <button>: the per-card checkbox
    // is interactive content and cannot legally nest inside a button. body
    // already sets --font-ui to Segoe UI, which is what the button defaulted to,
    // so switching element type does not change the text rendering.
    const card = document.createElement("div"); card.className = "media-card"; card.setAttribute("role", "button"); card.tabIndex = 0;
    card.dataset.assetId = asset.id;
    // The viewport-recycling grid reuses nodes across assets, so the checkbox
    // state is written on every paint rather than only at creation. Every asset
    // gets one: a still is exportable too, it just takes the JPEG path instead
    // of the colour pipeline.
    const select = document.createElement("span"); select.className = "card-select"; select.setAttribute("role", "checkbox"); select.setAttribute("aria-checked", "false"); select.tabIndex = 0;
    select.title = ts("batchExport.select");
    select.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); toggleBatchSelection(asset.id); });
    select.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault(); event.stopPropagation(); toggleBatchSelection(asset.id);
    });
    const thumb = document.createElement("div"); thumb.className = "thumb";
    const cachedUrl = thumbCache.get(thumbKey(asset.id)); if (cachedUrl) { const cached = document.createElement("img"); cached.src = cachedUrl; thumb.appendChild(cached); } else { thumb.appendChild(makePlaceholder()); }
    const main = document.createElement("div"); main.className = "card-main";
    const name = document.createElement("strong"); name.className = "card-name"; name.textContent = asset.original.name;
    const probe = asset.original.probe || {};
    // Each measurement is its own element rather than one joined sentence, so
    // duration / resolution / frame rate line up as columns down the list. A
    // shooter scanning a card compares those three across clips, and a run-on
    // string makes that impossible.
    const meta = document.createElement("div"); meta.className = "card-meta";
    const addMeta = (className, text) => { const span = document.createElement("span"); span.className = "card-meta-cell " + className; span.textContent = text; meta.appendChild(span); };
    if (asset.mediaKind === "photo") {
      addMeta("card-res", editorUiState.displayResolution(asset));
      addMeta("card-kind", (asset.original.extension || "").toUpperCase());
    } else {
      addMeta("card-dur", fmtDuration(probe.duration));
      addMeta("card-res", editorUiState.displayResolution(asset));
      addMeta("card-fps", probe.fps !== "UNKNOWN" && probe.fps ? Number(probe.fps.value).toFixed(2) : "?");
    }
    const badges = document.createElement("div"); badges.className = "card-badges";
    // Only the colour mode is allowed to carry a colour. It is the one badge
    // that changes what the user has to do next: D-Log M needs restoration,
    // everything else is a fact about the file, not a task. Previously codec,
    // bit depth, LRF, slow motion and colour mode each had their own hue, which
    // left the eye nowhere to land.
    if (/^D-Log(?:\s|$)/i.test(String(asset.djiColorMode || ""))) { const dlog = document.createElement("span"); dlog.className = "badge dlog"; dlog.dataset.i18n = "media.dlogBadge"; dlog.textContent = String(asset.djiColorMode).toUpperCase() === "D-LOG" ? "D-Log" : ts("media.dlogBadge"); badges.appendChild(dlog); }
    else if (asset.djiColorMode === "Standard") { const std = document.createElement("span"); std.className = "badge muted"; std.dataset.i18n = "color.normal"; std.textContent = ts("color.normal"); badges.appendChild(std); }
    if (asset.mediaKind === "photo") { const photo = document.createElement("span"); photo.className = "badge"; photo.dataset.i18n = "media.photoBadge"; photo.textContent = ts("media.photoBadge"); badges.appendChild(photo); }
    else if (asset.preview !== "UNKNOWN") { const proxy = document.createElement("span"); proxy.className = "badge proxy"; proxy.dataset.i18n = "media.lrfBadge"; proxy.textContent = ts("media.lrfBadge"); badges.appendChild(proxy); }
    if (typeof probe.profile === "string" && probe.profile.includes("10")) { const ten = document.createElement("span"); ten.className = "badge"; ten.dataset.i18n = "media.tenBit"; ten.textContent = ts("media.tenBit"); badges.appendChild(ten); }
    if (asset.captureMode === "SLOW_MOTION") { const slow = document.createElement("span"); slow.className = "badge slow"; slow.dataset.i18n = "media.slowMotion"; slow.textContent = ts("media.slowMotion"); badges.appendChild(slow); }
    main.append(name, meta, badges);
    if (select) card.append(select);
    card.append(thumb, main);
    card.addEventListener("click", () => open(asset.id));
    card.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault(); open(asset.id);
    });
    enqueueThumbnail(asset.id, thumb, priority);
    return { card, thumb, select };
  }
  function paintGrid() {
    const assets = activeAssets();
    const total = assets.length;
    // A single column wasted most of a desktop window: browsing a 411-file card
    // showed one 320px list with the rest of the window empty. The virtualizer
    // has always supported multiple columns (columnsFor/computeWindow); the
    // renderer was simply passing 1 and laying every card out on its own row.
    const view = viewGeometry();
    const columns = gridColumns();
    // Stretch the columns to the row they sit in, but never past it: in a narrow
    // rail the cards shrink instead of hanging off the edge.
    const fit = Math.floor((grid.clientWidth - LEFT * 2 - (columns - 1) * view.gap) / columns);
    const usable = Math.max(150, fit);
    const { start, end, spacerHeight } = computeWindow({ scrollTop: grid.scrollTop, viewportHeight: grid.clientHeight, itemHeight: view.itemH, gap: 0, columns, total, overscanRows: 2 });
    const selected = state.asset ? state.asset.id : null;
    const firstRow = Math.floor(grid.scrollTop / view.itemH);
    const lastRow = Math.ceil((grid.scrollTop + grid.clientHeight) / view.itemH);
    const active = new Set();
    const fragment = document.createDocumentFragment();
    let counted = 0;
    for (let i = start; i < end; i++) {
      const asset = assets[i];
      const row = Math.floor(i / columns);
      const column = i % columns;
      let node = cardNodes.get(asset.id);
      if (!node) { node = createCard(asset, row >= firstRow && row < lastRow ? 2 : 1); cardNodes.set(asset.id, node); }
      node.card.classList.toggle("selected", asset.id === selected);
      // Checkbox state is re-applied on every paint because the grid recycles
      // one node across different assets as the viewport scrolls. Photos have no
      // checkbox, so only the selected-card outline applies to them.
      const picked = node.select ? batchIds.has(asset.id) : false;
      if (node.select) node.select.setAttribute("aria-checked", picked ? "true" : "false");
      node.card.classList.toggle("picked", picked);
      node.card.style.top = (LEFT + row * view.itemH) + "px";
      node.card.style.left = (LEFT + column * (usable + view.gap)) + "px";
      node.card.style.width = usable + "px";
      fragment.appendChild(node.card);
      active.add(asset.id);
      if (row >= firstRow && row < lastRow) counted++;
    }
    for (const [id, node] of cardNodes) { if (!active.has(id)) node.card.remove(); }
    if (cardNodes.size > NODE_LIMIT) { for (const [id, node] of cardNodes) { if (active.has(id)) continue; cardNodes.delete(id); if (cardNodes.size <= NODE_LIMIT) break; } }
    visibleCount = counted;
    const prefetch = computePrefetchRange({ end, total, count: PREFETCH_AFTER });
    for (let i = prefetch.start; i < prefetch.end; i++) prefetchThumbnail(assets[i].id);
    const spacer = $("grid-spacer"); spacer.style.height = (spacerHeight + LEFT) + "px";
    const keep = $("scan-loading"); keep ? grid.replaceChildren(spacer, keep, fragment) : grid.replaceChildren(spacer, fragment);
    paintSelectAllControl(assets);
    renderStats();
  }

  grid.addEventListener("scroll", schedulePaint);
  window.addEventListener("resize", () => { schedulePaint(); syncRotatedTransform(); });

  // Switching view is a class change plus a repaint: the card markup is shared,
  // and the grid recomputes its geometry from state.view. No node is rebuilt.
  function setView(view) {
    if (view !== "list" && view !== "poster") return;
    state.view = view;
    document.body.classList.toggle("view-poster", view === "poster");
    for (const button of document.querySelectorAll("[data-view]")) button.classList.toggle("active", button.dataset.view === view);
    // Existing cards hold an <img> already resolved at the previous tier, so they
    // are dropped rather than reused. Rebuilding a few dozen tiles costs less
    // than tracking which tier each loaded image came from.
    for (const [, node] of cardNodes) node.card.remove();
    cardNodes.clear();
    grid.scrollTop = 0;
    paintGrid();
  }
  for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click", () => setView(button.dataset.view));

  function setFilter(filter) { openToken++; state.filter = filter; document.querySelectorAll("[data-filter]").forEach(b => b.classList.toggle("active", b.dataset.filter === filter)); reconcileSelection(); renderEmptyState(currentSnapshot() || { assets: [] }, state.source === "local"); paintGrid(); }
  document.querySelectorAll("[data-filter]").forEach(b => b.addEventListener("click", () => setFilter(b.dataset.filter)));
  $("sort-select").addEventListener("change", () => { state.sort = $("sort-select").value; updateNavigation(); paintGrid(); });
  $("rescan-button").addEventListener("click", () => { $("rescan-button").disabled = true; setScanStatus("scan.running"); api.scan().then(snapshot => { setScanStatus("scan.completed"); render(snapshot); }).catch(scanFailed).finally(() => { $("rescan-button").disabled = false; }); });

  function openSettings() { api.getSettings().then(s => { state.settings = s; $("settings-language").value = s.language || "en"; $("settings-export-location").value = s.exportLocation || ""; $("settings-overlay").hidden = false; }).catch(() => {}); }
  $("settings-button").addEventListener("click", openSettings);
  $("settings-close").addEventListener("click", () => { $("settings-overlay").hidden = true; });
  $("settings-language").addEventListener("change", () => { const lang = $("settings-language").value; window.i18n.setLanguage(lang); refreshDynamicLanguage(); setTimeout(() => { $("language-select").value = lang; }, 0); api.setSettings({ language: lang }); });
  $("language-select").addEventListener("change", () => { const lang = $("language-select").value; window.i18n.setLanguage(lang); refreshDynamicLanguage(); setTimeout(() => { $("settings-language").value = lang; }, 0); api.setSettings({ language: lang }); });
  $("settings-choose-folder").addEventListener("click", async () => { const dir = await api.chooseExportLocation(); $("settings-export-location").value = dir; });

  async function open(id) {
    const asset = activeAssets().find(a => a.id === id); if (!asset) return;
    const token = ++openToken;
    if (state.asset && state.asset.id !== id && exportingAssetId) { try { await api.cancelExport(); } catch {} }
    editRequestId++;
    releaseObsoletePreviewWaiters();
    if (state.asset) { const prevId = state.asset.id; if (prevId !== id) { try { api.renderPreviewStop({ assetId: prevId }); } catch {} } }
    let opened;
    try { opened = await api.openEditor(id); } catch (e) { if (token === openToken) fail(e); return; }
    if (token !== openToken || !editorUiState.selectionInAssets(activeAssets(), id)) return;
    state.asset = asset;
    resetPreviewZoom(); // a new clip starts the preview at 1x zoom
    const family = autoRestore.familyForCameraModel(asset.cameraModel);
    const isDlog = autoRestore.isDlogColorMode(asset.djiColorMode);
    const technical = autoRestore.technicalTransformFor(asset);
    const autoPreset = isDlog ? family + (family === "pocket4" || family === "pocket4p" ? "-dlog" : "-dlogm") : "normal";
    const watermarks = Array.isArray(opened.watermarks) ? opened.watermarks : [];
    const watermarkId = opened.watermark && opened.watermark.id || watermarks[0] && watermarks[0].id || "none";
    state.watermarkMatched = watermarks;
    state.watermarkCatalog = Array.isArray(opened.watermarkCatalog) ? opened.watermarkCatalog : [];
    const select = $("watermark");
    if (select) { select.replaceChildren(new Option(ts("watermark.none"), "none")); for (const entry of watermarks) select.appendChild(new Option(entry.familyName + " " + badgePicker.variantLabel(entry.variant, ts), entry.id)); }
    editorBadgePicker.refresh();
    state.editor = { clip: { ...opened.clip }, colorPreset: autoPreset, technicalTransform: technical, creativeLook: "", displayTransform: { ...opened.clip.displayTransform }, watermark: { id: watermarkId, enabled: false, scale: 0.195, opacity: 1, position: { x: 0.5, y: 1 } } };
    state.timelineZoom = 1;
    state.wmPosition = "bottomCenter";
    const poster = $("poster-preview");
    api.getPosterUrl(asset.id).then(url => { if (url && state.asset && state.asset.id === asset.id) { poster.src = url; poster.hidden = false; } }).catch(() => {});
    const timelineThumbs = $("timeline-thumbnails");
    if (timelineThumbs) {
      timelineThumbs.style.backgroundImage = "";
      api.getThumbnailUrl(asset.id, THUMB_TIERS.list).then(result => { const url = result && (result.url || result); if (url && state.asset && state.asset.id === asset.id) timelineThumbs.style.backgroundImage = "url('" + String(url).replace(/'/g, "%27") + "')"; }).catch(() => {});
    }
    if (asset.preview !== "UNKNOWN" && asset.preview.probe && asset.preview.probe.height !== "UNKNOWN") $("proxy-label").textContent = "Proxy LRF (" + asset.preview.probe.height + "p)";
    else $("proxy-label").textContent = asset.source === "local" ? "Original (direct)" : "Original (direct, auto-fallback)";
    const isPhoto = asset.mediaKind === "photo";
    const hint = $("color-detect-hint");
    if (hint) { if (isDlog || asset.djiColorMode === "Standard") { hint.hidden = false; hint.textContent = ts("color.detectHint") + ": " + (isDlog ? ts("color.detectedDlog") : ts("color.detectedNormal")); } else { hint.hidden = true; } }
    syncInspectorFromEditor(); setAssetControls(asset); renderExportFacts(); paintGrid();
    await browse();
    if (token !== openToken) return;
    // A detected D-Log clip opens with restoration selected. Enter the live
    // effect path immediately so the visible image matches those controls.
    if (!isPhoto && autoPreset !== "normal") await edit();
  }

  function syncInspectorFromEditor() { const editor = state.editor || {}; const clip = editor.clip || {}; const tf = editor.displayTransform || {}; const technical = editor.technicalTransform || (editor.colorPreset === "action4-dlogm" ? "action4" : editor.colorPreset === "action5pro-dlogm" ? "action5pro" : editor.colorPreset === "action6-dlogm" ? "action6" : "none"); const creative = editor.creativeLook !== undefined ? editor.creativeLook : ""; $("color-profile").value = editorUiState.colorProfileForTechnical(technical); $("technical-transform").value = technical; $("creative-look").value = creative; $("trim-in").value = editorUiState.secondsFromMicroseconds(clip.sourceInUs); $("trim-out").value = editorUiState.secondsFromMicroseconds(clip.sourceOutUs); $("speed").value = String(clip.playbackRate || 1); $("rotate").value = String(tf.rotation || 0); $("crop").value = String(tf.crop && tf.crop.left || 0); $("flip-h").checked = !!tf.flipHorizontal; $("flip-v").checked = !!tf.flipVertical; const wm = editor.watermark || {}; $("watermark-enable").checked = !!wm.enabled; $("watermark").disabled = !wm.enabled; $("watermark").value = wm.id || "none"; $("watermark-scale").value = String(editorUiState.numberOrDefault(wm.scale, 0.195)); $("watermark-opacity").value = String(editorUiState.numberOrDefault(wm.opacity, 1)); editorBadgePicker.refresh(); paintExportSpec(); const exportSection = document.querySelector('.acc-item[data-acc="export"]'); if (exportSection) exportSection.hidden = !editor.clip || (state.asset && state.asset.mediaKind === "photo"); }

  function editorFromControls() { const editor = state.editor || {}; const clip = { ...(editor.clip || {}) }; const durationUs = Number(clip.sourceOutUs || video.duration * 1000000 || 1); let segments = timelineModel ? timelineModel.normalize(editor.segments, durationUs) : []; const sourceIn = editorUiState.microsecondsFromSeconds($("trim-in").value); const requestedOut = editorUiState.microsecondsFromSeconds($("trim-out").value); if (!segments.length) segments = [{ id: "segment-1", sourceInUs: sourceIn, sourceOutUs: Math.max(sourceIn + 1, requestedOut || durationUs) }]; const first = segments[0], last = segments[segments.length - 1]; clip.sourceInUs = first.sourceInUs; clip.sourceOutUs = last.sourceOutUs; clip.playbackRate = Number($("speed").value) || 1; const creativeLook = $("creative-look").value; const colorProfile = $("color-profile").value; const technicalTransform = $("technical-transform").value; const watermark = editorUiState.watermarkFromControls({ id: $("watermark").value, enabled: $("watermark-enable").checked, scale: $("watermark-scale").value, opacity: $("watermark-opacity").value, position: state.wmPosition }, WM_POSITIONS); return { ...editor, clip, segments, colorPreset: presetFor(colorProfile, technicalTransform, creativeLook), technicalTransform, creativeLook, displayTransform: { rotation: Number($("rotate").value) || 0, crop: { left: Number($("crop").value) || 0, top: 0, right: 0, bottom: 0 }, flipHorizontal: $("flip-h").checked, flipVertical: $("flip-v").checked }, watermark }; }

  function syncVideoClock(editor) {
    const clip = editor && editor.clip || {};
    const sourceIn = Number(clip.sourceInUs || 0) / 1000000;
    const sourceOut = Number(clip.sourceOutUs || 0) / 1000000;
    video.playbackRate = Math.max(0.1, Number(clip.playbackRate || 1));
    if (video.currentTime < sourceIn || (sourceOut > sourceIn && video.currentTime >= sourceOut)) video.currentTime = sourceIn;
  }

  function previewTimelineSeconds(editor) {
    return editorUiState.previewTimelineSeconds(video.currentTime, editor && editor.clip);
  }

  function renderExportFacts() { const asset = state.asset; const box = $("export-facts"); box.replaceChildren(); if (!editorUiState.shouldRenderExportFacts(asset)) return; const probe = asset.original.probe || {}; const exportDuration = editorUiState.exportDurationSeconds(state.editor && state.editor.clip, probe.duration); const facts = [["Format", "H.264 MP4"], ["Resolution", probe.width !== "UNKNOWN" && probe.width ? probe.width + "x" + probe.height : "UNKNOWN"], ["FPS", probe.fps !== "UNKNOWN" && probe.fps ? String(Number(probe.fps.value).toFixed(2)) : "UNKNOWN"], ["Quality", "CRF 18"], ["Duration", fmtClock(exportDuration || 0)]]; for (const [label, value] of facts) { const row = document.createElement("div"); const dt = document.createElement("dt"); const key = "export." + label.toLowerCase().replace(/ /g, ""); dt.dataset.i18n = key; dt.textContent = ts(key); const dd = document.createElement("dd"); dd.textContent = String(value); row.append(dt, dd); box.appendChild(row); } }

  async function setMode(mode) { state.mode = mode; return editorUiState.switchMode(mode, { edit, browse }); }

  function syncModeControls() {
    const editable = !!state.asset && state.asset.mediaKind !== "photo";
    $("mode-original").disabled = !editable;
    $("mode-effects").disabled = !editable;
    $("mode-original").classList.toggle("active", editable && state.mode === "browse");
    $("mode-effects").classList.toggle("active", editable && state.mode === "edit");
  }
  $("mode-original").addEventListener("click", () => { if (state.asset && state.asset.mediaKind !== "photo") setMode("browse").catch(fail); });
  $("mode-effects").addEventListener("click", () => { if (state.asset && state.asset.mediaKind !== "photo") setMode("edit").catch(fail); });

  const progressFill = $("preview-progress-fill"), progressTrack = $("preview-progress"), progressLabel = $("preview-progress-label");
  function showGenerating(pct) {
    const empty = $("video-empty");
    empty.hidden = false;
    $("video-empty-text").textContent = ts("preview.generating");
    progressTrack.hidden = false; progressLabel.hidden = false;
    progressFill.style.width = Math.max(2, pct) + "%";
    progressLabel.textContent = pct + "%";
  }
  function hideGenerating() { progressTrack.hidden = true; progressLabel.hidden = true; }
  function setEmptyIcon(spin) {
    const icon = $("video-empty").querySelector(".video-empty-icon");
    if (!icon) return;
    icon.classList.toggle("spinning", !!spin);
    // Swap the glyph, not just the animation: a spinning play triangle reads as
    // a decoration, while a spinner arc reads as work in progress.
    icon.innerHTML = iconSet.get(spin ? "spinner" : "play");
  }
  // Generic "video is becoming ready" indicator (LRF fetch, buffering, seek).
  function showVideoBusy() {
    if (state.mode !== "browse") return;
    const empty = $("video-empty");
    empty.hidden = false;
    $("video-empty-text").textContent = ts("preview.loading");
    setEmptyIcon(true);
  }
  function videoReady() {
    const empty = $("video-empty");
    if (!empty.hidden || !progressTrack.hidden) { empty.hidden = true; hideGenerating(); setEmptyIcon(false); }
  }
  let previewToken = 0;
  let fallbackArmed = false;
  async function tryFallback() {
    if (!fallbackArmed || !state.asset) return;
    fallbackArmed = false;
    rotatedSourceArmed = false; // the fallback proxy is already upright/letterboxed - never rotate it
    showGenerating(0);
    let result = null;
    try { result = await api.getPreviewFallback(state.asset.id); } catch {}
    if (result) { video.src = result.url || ""; video.load(); $("video-empty").hidden = true; hideGenerating(); try { await video.play(); } catch {} return; }
    hideGenerating(); setEmptyIcon(false);
    $("video-empty").hidden = false;
    $("video-empty-text").textContent = ts("preview.unavailable");
    showError(ts("preview.fallbackFailed"), true);
  }

  // Portrait sources: DJI vertical clips carry probe rotation ±90 in
  // asset.displayGeometry.original.rotation. Chromium's media stack honors the
  // display matrix itself (videoWidth/videoHeight come out swapped - 2160x3840
  // for the 0370 clip), so playback is already upright and needs no transform;
  // the element is only marked with .rotated. If a media stack ever ignores the
  // matrix, the box stays landscape while the picture lies sideways - detect
  // that from the element box and rotate it upright with a compensating scale
  // that keeps the picture inside the shell.
  let rotatedSourceArmed = false;
  function rotationForAsset(asset) {
    const rot = asset && asset.displayGeometry && asset.displayGeometry.original ? asset.displayGeometry.original.rotation : null;
    return typeof rot === "number" && Math.abs(rot) % 180 === 90 ? rot : null;
  }
  function syncRotatedTransform() {
    if (!video.classList.contains("rotated-apply")) { video.style.transform = ""; return; }
    const shell = video.parentElement;
    if (!shell) return;
    const w = shell.clientWidth, h = shell.clientHeight;
    if (!w || !h) return;
    const scale = Math.min(w / h, h / w);
    const deg = video.dataset.rot === "90" ? 90 : -90;
    video.style.transform = "rotate(" + deg + "deg) scale(" + scale.toFixed(4) + ")";
  }
  function checkVideoRotation() {
    if (!rotatedSourceArmed) return;
    rotatedSourceArmed = false;
    // Landscape box while the asset says quarter-turn => matrix was ignored.
    const ignored = video.videoWidth > video.videoHeight;
    video.classList.toggle("rotated-apply", ignored);
    syncRotatedTransform();
  }
  async function browse() {
    editRequestId++;
    releaseObsoletePreviewWaiters();
    state.mode = "browse"; video.playbackRate = 1; image.hidden = true; canvas.hidden = true; video.hidden = false; $("poster-preview").hidden = true; hideError();
    syncModeControls();
    stopPreviewLoop(); previewEntryPaused = false; clockHeldForLaunch = false; if (canvasSurface) canvasSurface.clear();
    if (state.asset) { try { api.renderPreviewStop({ assetId: state.asset.id }); } catch {} }
    const token = ++previewToken;
    fallbackArmed = false;
    if (progressFill) progressFill.style.width = "0%";
    if (!state.asset) { $("preview-debug").textContent = "Mode: BROWSE | Source: - | Type: LRF_PROXY"; $("video-empty").hidden = true; return; }
    const hasLrf = state.asset.preview && state.asset.preview !== "UNKNOWN";
    const sourceLabel = hasLrf ? state.asset.preview.name : (state.asset.source === "local" ? "Original (direct)" : "- (Original direct, fallback on error)");
    $("preview-debug").textContent = "Mode: BROWSE | Source: " + sourceLabel + " | Type: " + (hasLrf ? "LRF_PROXY" : "ORIGINAL");
    if (progressFill) progressFill.style.width = "0%";
    showVideoBusy();
    const result = await api.getPreviewUrl(state.asset.id);
    if (token !== previewToken) return;
    if (!result) { video.removeAttribute("src"); video.load(); $("video-empty").hidden = false; $("video-empty-text").textContent = ts("preview.unavailable"); hideGenerating(); setEmptyIcon(false); $("play-button").disabled = true; return; }
    if (state.asset.mediaKind === "photo") {
      video.pause(); video.removeAttribute("src"); video.load(); video.hidden = true;
      const poster = $("poster-preview"); poster.src = result.url || ""; poster.hidden = false; $("video-empty").hidden = true;
      $("play-button").disabled = true; updateNavigation(); setStateBadge(ts("preview.photo"), false, "preview.photo");
      $("preview-debug").textContent = "Mode: BROWSE | Source: " + state.asset.original.name + " | Type: PHOTO";
      return;
    }
    // Portrait-source handling (DJI vertical clips, rotation ±90): mark the
    // element and arm the matrix-ignored check only when the ORIGINAL is played
    // (LRF/fallback proxies are upright and letterboxed already).
    const rot = rotationForAsset(state.asset);
    video.classList.remove("rotated-apply"); video.style.transform = "";
    video.classList.toggle("rotated", rot !== null);
    video.dataset.rot = rot !== null ? String(rot === 90 ? 90 : -90) : "";
    rotatedSourceArmed = rot !== null && result.sourceType === "ORIGINAL";
    video.src = result.url || ""; video.load(); $("play-button").disabled = false; setStateBadge(hasLrf ? "LRF" : ts("preview.original"), false, hasLrf ? null : "preview.original"); fallbackArmed = !hasLrf && result.sourceType !== "LRF_PROXY"; try { await video.play(); } catch {}
  }
  function setStateBadge(text, ok, i18nKey) {
    const badge = $("preview-state");
    badge.hidden = !text;
    badge.textContent = text ? (ok ? "● " : "") + text : "";
    badge.className = "preview-state" + (ok ? " live" : "");
    if (i18nKey) badge.dataset.i18nState = i18nKey; else delete badge.dataset.i18nState;
  }

  function refreshDynamicLanguage() {
    const badge = $("preview-state");
    if (badge.dataset.i18nState) badge.textContent = (badge.classList.contains("live") ? "● " : "") + ts(badge.dataset.i18nState);
    renderEmptyState(currentSnapshot() || { assets: [] }, state.source === "local");
    if (!state.asset) return;
    const hint = $("color-detect-hint");
    if (!hint.hidden && (/^D-Log(?:\s|$)/i.test(String(state.asset.djiColorMode || "")) || state.asset.djiColorMode === "Standard")) hint.textContent = ts("color.detectHint") + ": " + (/^D-Log(?:\s|$)/i.test(String(state.asset.djiColorMode || "")) ? ts("color.detectedDlog") : ts("color.detectedNormal"));
    renderExportFacts();
    // Media cards are virtualized and create their badge text at paint time;
    // repaint the active window so card badges follow a runtime language switch.
    paintGrid();
  }

  async function edit() {
    if (!state.asset || state.asset.mediaKind === "photo") return;
    const editingAsset = state.asset;
    const token = openToken;
    state.mode = "edit"; video.hidden = false; image.hidden = true; canvas.hidden = true; hideError();
    syncModeControls();
    const colorCritical = /^D-LOG(?:\s|$)/i.test(String(state.asset.djiColorMode || ""));
    const source = !colorCritical && state.asset.preview && state.asset.preview !== "UNKNOWN" ? state.asset.preview.name : null;
    $("preview-debug").textContent = "Mode: EDIT | Source: " + (source || (state.asset.original && state.asset.original.name) || "-") + " | Type: " + (colorCritical ? "ORIGINAL_COLOR_EDIT_PREVIEW" : (source ? "LRF_EDIT_PREVIEW" : "ORIGINAL_EDIT_PREVIEW"));
    try {
      const editor = editorFromControls(); state.editor = editor;
      syncVideoClock(editor);
      latestPreviewFrame = null; previewFrameDirty = false; pendingEarlyFrame = null; previewLag.reset();
      // browse() already started the raw clip to give the user something to look
      // at. Entering the effect path must stop it: left running it plays the
      // ungraded image for the whole ffmpeg spawn, and its audio clock would keep
      // advancing so the processed frames arrive permanently behind the sound.
      const resumeAfterLaunch = pauseClockSilently();
      previewEntryPaused = video.paused && !resumeAfterLaunch;
      setStateBadge(ts("preview.applying"), false, "preview.applying");
      // A stuck decoder must not leave the editor waiting forever. Fallback
      // generation gets a generous window; direct LRF/original decode normally
      // resolves in a few seconds.
      const started = await withTimeout(api.renderPreviewStart({ assetId: editingAsset.id, timelineSeconds: previewTimelineSeconds(editor), editor }), 90000, ts("preview.timeout"));
      // Starting ffmpeg only proves that the process was spawned. Wait for a
      // frame from this launch before enabling the editor, otherwise a slower
      // D-Log/LRF decode presents an empty canvas as a working preview.
      await waitForPreviewGeneration(editingAsset.id, started && started.launchGeneration, 12000);
      if (token !== openToken || !state.asset || state.asset.id !== editingAsset.id || state.mode !== "edit") {
        clockHeldForLaunch = false;
        try { await api.renderPreviewStop({ assetId: editingAsset.id }); } catch {}
        return;
      }
      $("play-button").disabled = false;
      setStateBadge(ts("preview.liveEffects"), true, "preview.liveEffects");
      // The clock feedback that gates the decoder is emitted from the paint loop,
      // so the loop must run on its own rAF cadence rather than only when a frame
      // arrives. Driven by frame arrival alone it self-locks: the gate withholds
      // frames until the clock advances, but the clock is only reported when a
      // frame arrives, so neither side ever moves and the canvas freezes.
      startPreviewLoop();
      // The first processed frame is on screen, so audio may now start against a
      // decoder that is already producing. This is the point that removes the
      // half-second offset rather than measuring and absorbing it.
      if (resumeAfterLaunch) playClockSilently();
    } catch (e) {
      clockHeldForLaunch = false;
      try { await api.renderPreviewStop({ assetId: editingAsset.id }); } catch {}
      if (token !== openToken || !state.asset || state.asset.id !== editingAsset.id) return;
      // Do not leave a failed Effects launch with an active edit mode and a
      // blank canvas. Restore the original preview so the user has a usable
      // surface while the retry action remains available.
      state.mode = "browse";
      syncModeControls();
      try { await browse(); } catch {}
      if (token !== openToken || !state.asset || state.asset.id !== editingAsset.id) return;
      if (e && e.message === ts("preview.timeout")) showError(e.message, true); else fail(e);
      setStateBadge("", false);
    }
  }

  const seekTrack = $("seek-track");
  function applySeek(ratio) { const duration = video.duration || 0; let seconds = Math.max(0, Math.min(duration, ratio * duration)); if (state.editor && state.editor.clip) seconds = clampTimeToRange(seconds, (state.editor.clip.sourceInUs || 0) / 1000000, (state.editor.clip.sourceOutUs || 0) / 1000000); video.currentTime = seconds; }
  function seekFromEvent(e) { const rect = seekTrack.getBoundingClientRect(); applySeek(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))); drawPlayer(); }
  seekTrack.addEventListener("pointerdown", e => { try { seekTrack.setPointerCapture(e.pointerId); } catch {} seekFromEvent(e); seekTrack._dragging = true; });
  seekTrack.addEventListener("pointermove", e => { if (seekTrack._dragging) seekFromEvent(e); });
  seekTrack.addEventListener("pointerup", e => { seekTrack._dragging = false; try { seekTrack.releasePointerCapture(e.pointerId); } catch {} });

  function drawPlayer() {
    const duration = video.duration || 0; const current = video.currentTime || 0;
    $("current-time").textContent = fmtClock(current); $("total-time").textContent = fmtClock(duration);
    const ratio = duration > 0 ? Math.max(0, Math.min(1, current / duration)) : 0;
    $("seek-fill").style.width = (ratio * 100) + "%";
    seekTrack.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    $("timeline-current").textContent = fmtClock(current); $("timeline-duration").textContent = fmtClock(duration);
    $("playhead").style.left = (ratio * 100) + "%";
    renderTimelineSegments();
  }
  function renderTimelineSegments() { const host = $("timeline-segments"), ruler = $("timeline-ruler"), duration = video.duration || 0; if (!host || !(duration > 0)) return; const segments = timelineModel ? timelineModel.normalize(state.editor && state.editor.segments, duration * 1000000) : []; host.replaceChildren(); host.style.width = (100 * state.timelineZoom) + "%"; for (const segment of segments) { const el = document.createElement("div"); el.className = "timeline-segment" + (segment.id === state.selectedSegmentId ? " selected" : ""); el.dataset.id = segment.id; el.style.left = (segment.sourceInUs / 1000000 / duration * 100) + "%"; el.style.width = ((segment.sourceOutUs - segment.sourceInUs) / 1000000 / duration * 100) + "%"; el.innerHTML = '<span class="segment-handle segment-handle-in"></span><span class="segment-label"></span><span class="segment-handle segment-handle-out"></span>'; el.querySelector(".segment-label").textContent = fmtDuration((segment.sourceOutUs - segment.sourceInUs) / 1000000); el.addEventListener("pointerdown", e => { if (e.target.classList.contains("segment-handle")) return; e.stopPropagation(); state.selectedSegmentId = segment.id; const startX = e.clientX, original = segment.sourceInUs; try { el.setPointerCapture(e.pointerId); } catch {} const move = ev => { const delta = (ev.clientX - startX) / Math.max(1, host.getBoundingClientRect().width) * duration * 1000000 / state.timelineZoom; state.editor.segments = timelineModel.moveSegment(state.editor.segments, segment.id, delta, duration * 1000000); drawPlayer(); queueTrimEdit(); }; const end = () => { el.removeEventListener("pointermove", move); renderExportFacts(); }; el.addEventListener("pointermove", move); el.addEventListener("pointerup", end, { once: true }); el.addEventListener("pointercancel", end, { once: true }); }); el.addEventListener("click", e => { e.stopPropagation(); state.selectedSegmentId = segment.id; renderTimelineSegments(); }); host.appendChild(el); } if (ruler) { ruler.replaceChildren(); const step = duration > 30 ? 10 : duration > 10 ? 5 : 1; for (let t = 0; t <= duration + .001; t += step) { const tick = document.createElement("span"); tick.textContent = fmtDuration(t); tick.style.left = (t / duration * 100 * state.timelineZoom) + "%"; ruler.appendChild(tick); } } const clip = state.editor && state.editor.clip; if (clip) { $("trim-in").value = editorUiState.secondsFromMicroseconds(segments[0] ? segments[0].sourceInUs : clip.sourceInUs); $("trim-out").value = editorUiState.secondsFromMicroseconds(segments.length ? segments[segments.length - 1].sourceOutUs : clip.sourceOutUs); } }

  function renderTimelineSegments() { const duration = video.duration || 0, clip = state.editor && state.editor.clip; const track = $("timeline-zoom-content"); if (!track || !(duration > 0) || !clip) return; const scale = state.timelineZoom; track.style.width = (100 * scale) + "%"; $("timeline-thumbnails").style.width = "100%"; const start = (clip.sourceInUs || 0) / 1000000 / duration * 100, end = (clip.sourceOutUs || duration * 1000000) / 1000000 / duration * 100; $("timeline-clip").style.left = start + "%"; $("timeline-clip").style.width = Math.max(0, end - start) + "%"; $("timeline-trim-dim-left").style.width = start + "%"; $("timeline-trim-dim-right").style.left = end + "%"; $("timeline-trim-dim-right").style.width = Math.max(0, 100 - end) + "%"; $("playhead").style.left = ((video.currentTime || 0) / duration * 100) + "%"; $("timeline-zoom-value").textContent = Math.round(scale * 100) + "%"; /* The brackets are the two ends of the kept range: without this they sat parked at the edges of the track. Their inner edge faces the kept part, so the out bracket is pulled back by its own width. */ const inHandle = $("trim-in-handle"), outHandle = $("trim-out-handle"); if (inHandle) { inHandle.style.left = start + "%"; inHandle.style.right = "auto"; } if (outHandle) { outHandle.style.left = "calc(" + end + "% - 16px)"; outHandle.style.right = "auto"; } }
  video.addEventListener("canplay", () => { $("poster-preview").hidden = true; videoReady(); });
  video.addEventListener("playing", () => { videoReady(); });
  video.addEventListener("loadstart", () => { if (state.mode === "browse" && state.asset) showVideoBusy(); });
  video.addEventListener("waiting", () => { if (state.mode === "browse" && state.asset) showVideoBusy(); });
  video.addEventListener("seeking", () => { if (state.mode === "browse" && state.asset) showVideoBusy(); });
      video.addEventListener("seeked", () => { if (state.mode === "edit" && state.asset) { pendingEarlyFrame = null; previewLag.reset(); previewEndedRestarts = 0; previewEntryPaused = video.paused; api.renderPreviewSeek({ assetId: state.asset.id, timelineSeconds: previewTimelineSeconds(state.editor) }); } videoReady(); });
  video.addEventListener("error", () => { if (state.mode === "browse" && state.asset) { if (fallbackArmed) { tryFallback(); return; } $("video-empty").hidden = false; $("video-empty-text").textContent = ts("preview.unavailable"); hideGenerating(); setEmptyIcon(false); } });
  video.addEventListener("loadedmetadata", () => { drawPlayer(); checkVideoRotation(); }); video.addEventListener("durationchange", drawPlayer); // Trim clamping must use a dead band. Writing currentTime fires `seeked`, and
// every `seeked` SIGKILLs and respawns ffmpeg, so a comparison tight enough to
// trip on float noise restarted the decoder on every timeupdate tick.
video.addEventListener("timeupdate", () => { if (state.mode === "edit" && state.editor && state.editor.clip) { const clamp = previewClock.trimClampAction(video.currentTime, state.editor.clip); if (clamp.shouldPause) video.pause(); if (clamp.seekTo !== null) video.currentTime = clamp.seekTo; } drawPlayer(); }); video.addEventListener("seeking", drawPlayer); video.addEventListener("seeked", drawPlayer); video.addEventListener("ended", drawPlayer);
  video.addEventListener("play", () => { $("play-button").innerHTML = ICON_PAUSE; $("play-button").dataset.i18nAriaLabel = "player.pause"; $("play-button").setAttribute("aria-label", ts("player.pause")); if (suppressPlayIpc > 0) { suppressPlayIpc -= 1; return; } if (state.mode === "edit" && state.asset) resumePreviewInSync(); });
  video.addEventListener("pause", () => { $("play-button").innerHTML = ICON_PLAY; $("play-button").dataset.i18nAriaLabel = "player.play"; $("play-button").setAttribute("aria-label", ts("player.play")); if (suppressPauseIpc > 0) { suppressPauseIpc -= 1; return; } if (state.mode === "edit" && state.asset) api.renderPreviewPause({ assetId: state.asset.id }); });
  // Resume without letting the audio clock run ahead of the decoder. The clock is
  // held while ffmpeg respawns and released only once the first frame of that
  // launch has been painted, so picture and sound restart on the same instant.
  async function resumePreviewInSync() {
    const asset = state.asset;
    if (!asset) return;
    const token = openToken;
    const held = pauseClockSilently();
    pendingEarlyFrame = null; previewLag.reset(); previewEndedRestarts = 0;
    const stillCurrent = () => token === openToken && state.asset && state.asset.id === asset.id && state.mode === "edit";
    try {
      const resumed = await api.renderPreviewResume({ assetId: asset.id, timelineSeconds: previewTimelineSeconds(state.editor) });
      if (!stillCurrent()) return;
      await waitForPreviewGeneration(asset.id, resumed && resumed.launchGeneration, 8000, stillCurrent);
    } catch {
      // A failed or timed-out relaunch must not strand the player in a paused
      // state the user did not ask for; fall through and release the clock.
    }
    if (held && stillCurrent()) playClockSilently();
    // The asset changed under us. Leave the clock where it is, but clear the
    // hold so the flag cannot outlive this launch and mask a real paused state.
    else clockHeldForLaunch = false;
  }
  async function togglePlayback() {
    if (!video.paused) { video.pause(); return; }
    const clip = state.editor && state.editor.clip;
    const sourceIn = clip ? Number(clip.sourceInUs || 0) / 1000000 : 0;
    const sourceOut = clip ? Number(clip.sourceOutUs || 0) / 1000000 : Number(video.duration || 0);
    const startTime = editorUiState.playbackStartTime({ currentTime: video.currentTime, ended: video.ended, sourceIn, sourceOut });
    if (Math.abs(startTime - video.currentTime) > 0.001) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 300);
        video.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
        video.currentTime = startTime;
      });
    }
    try { await video.play(); } catch (e) { fail(e); }
  }
  $("play-button").addEventListener("click", togglePlayback);
  $("play-button").innerHTML = ICON_PLAY;
  // Fit selector applies to every preview surface: the playing video element,
  // the live effect frame (#color-preview) and the poster image (#poster-preview).
  const fitFor = mode => mode === "fit" ? "contain" : mode; // "fit"/"contain" -> contain; "cover" -> cover
  $("fit-select").addEventListener("change", () => { const objectFit = fitFor($("fit-select").value); video.style.objectFit = objectFit; image.style.objectFit = objectFit; canvas.style.objectFit = objectFit; $("poster-preview").style.objectFit = objectFit; });

  // Mouse-wheel zoom: the listener is attached to .video-shell so it receives
  // wheel events bubbling from whichever preview surface is on top (video,
  // poster, live-effect frame). The scale is applied to .shell-content, the box
  // that wraps all three surfaces, anchored at the pointer position.
  const previewShell = document.querySelector(".video-shell");
  const shellContent = document.querySelector(".video-shell .shell-content");
  const zoomBadge = document.getElementById("zoom-badge");
  const ZOOM_MIN = 1, ZOOM_MAX = 8, ZOOM_STEP = 1.12;
  let previewZoom = 1;
  function updateZoomBadge() {
    if (!zoomBadge) return;
    if (previewZoom <= ZOOM_MIN) { zoomBadge.hidden = true; zoomBadge.textContent = ""; return; }
    zoomBadge.hidden = false;
    zoomBadge.textContent = previewZoom.toFixed(1) + "x";
  }
  function applyPreviewZoom(originX, originY) {
    if (!shellContent) return;
    if (previewZoom <= ZOOM_MIN) { shellContent.style.transform = ""; shellContent.style.transformOrigin = ""; updateZoomBadge(); return; }
    shellContent.style.transformOrigin = (Number.isFinite(originX) ? originX : 50) + "% " + (Number.isFinite(originY) ? originY : 50) + "%";
    shellContent.style.transform = "scale(" + previewZoom.toFixed(4) + ")";
    updateZoomBadge();
  }
  function resetPreviewZoom() { previewZoom = ZOOM_MIN; applyPreviewZoom(); }
  if (previewShell) {
    previewShell.addEventListener("wheel", e => {
      const rect = previewShell.getBoundingClientRect();
      const ox = rect.width > 0 ? Math.max(0, Math.min(100, (e.clientX - rect.left) / rect.width * 100)) : 50;
      const oy = rect.height > 0 ? Math.max(0, Math.min(100, (e.clientY - rect.top) / rect.height * 100)) : 50;
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      previewZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, previewZoom * factor));
      applyPreviewZoom(ox, oy);
      e.preventDefault();
    }, { passive: false });
    previewShell.addEventListener("dblclick", resetPreviewZoom);
  }

  function stepOffset(delta) { const list = activeAssets(); if (!list.length || !state.asset) return; const index = list.findIndex(a => a.id === state.asset.id); const next = list[index + delta]; if (next) open(next.id); }
  $("btn-prev").addEventListener("click", () => stepOffset(-1)); $("btn-next").addEventListener("click", () => stepOffset(1));

  document.querySelectorAll(".acc-head").forEach(head => head.addEventListener("click", () => { const item = head.closest(".acc-item"); const open = item.classList.contains("open"); document.querySelectorAll(".acc-item").forEach(i => i.classList.remove("open")); if (!open) item.classList.add("open"); }));

  for (const id of ["color-profile", "technical-transform", "creative-look", "trim-in", "trim-out", "speed", "rotate", "crop", "flip-h", "flip-v", "watermark", "watermark-scale", "watermark-opacity", "watermark-enable"]) { $(id).addEventListener("change", () => { if (id === "watermark-enable") $("watermark").disabled = !$("watermark-enable").checked; if (id === "color-profile") $("technical-transform").value = editorUiState.technicalForColorProfile($("color-profile").value); if (id === "technical-transform") $("color-profile").value = editorUiState.colorProfileForTechnical($("technical-transform").value); scheduleEdit(); renderExportFacts(); }); $(id).addEventListener("input", () => { scheduleEdit(); }); }

  const timelineTrack = $("timeline-track");
  let trimEditQueued = false;
  function queueTrimEdit() {
    if (trimEditQueued) return;
    trimEditQueued = true;
    requestAnimationFrame(() => { trimEditQueued = false; if (state.mode === "edit") scheduleEdit(); });
  }
  function timelineSeekFromEvent(e) { const rect = timelineTrack.getBoundingClientRect(); const ratio = Math.max(0, Math.min(1, (timelineTrack.scrollLeft + e.clientX - rect.left) / Math.max(1, rect.width * state.timelineZoom))); applySeek(ratio); drawPlayer(); }
  timelineTrack.addEventListener("pointerdown", e => { if (e.target.classList.contains("trim-handle")) return; try { timelineTrack.setPointerCapture(e.pointerId); } catch {} if (!video.paused) video.pause(); timelineSeekFromEvent(e); timelineTrack._dragging = true; timelineTrack.classList.add("dragging"); });
  timelineTrack.addEventListener("pointermove", e => { if (timelineTrack._dragging) timelineSeekFromEvent(e); });
  timelineTrack.addEventListener("pointerup", e => { timelineTrack._dragging = false; timelineTrack.classList.remove("dragging"); try { timelineTrack.releasePointerCapture(e.pointerId); } catch {} });
  timelineTrack.addEventListener("pointercancel", e => { timelineTrack._dragging = false; timelineTrack.classList.remove("dragging"); try { timelineTrack.releasePointerCapture(e.pointerId); } catch {} });

  function bindTrimHandle(handle, isIn) { handle.addEventListener("pointerdown", e => { e.preventDefault(); try { handle.setPointerCapture(e.pointerId); } catch {} if (!video.paused) video.pause(); timelineTrack.classList.add("dragging"); const move = ev => { const rect = timelineTrack.getBoundingClientRect(); const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)); const duration = video.duration || 0; const clip = state.editor && state.editor.clip; if (!clip) return; const other = isIn ? (clip.sourceOutUs || 0) / 1000000 : (clip.sourceInUs || 0) / 1000000; const result = trimFromEvent(ratio, duration, isIn, other); $("trim-in").value = result.sourceIn.toFixed(3); $("trim-out").value = result.sourceOut.toFixed(3); drawPlayer(); renderExportFacts(); queueTrimEdit(); }; const end = () => { handle.removeEventListener("pointermove", move); timelineTrack.classList.remove("dragging"); }; handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", end, { once: true }); handle.addEventListener("pointercancel", end, { once: true }); }); }
  bindTrimHandle($("trim-in-handle"), true); bindTrimHandle($("trim-out-handle"), false);
  function setTimelineZoom(value, anchorX) { const old = state.timelineZoom; state.timelineZoom = Math.max(1, Math.min(12, Number(value) || 1)); const track = $("timeline-track"); if (track && anchorX != null) { const rect = track.getBoundingClientRect(); const before = (track.scrollLeft + anchorX - rect.left) / old; renderTimelineSegments(); track.scrollLeft = Math.max(0, before * state.timelineZoom - anchorX + rect.left); } else renderTimelineSegments(); }
  $("timeline-zoom-fit").addEventListener("click", () => { const track = $("timeline-track"); if (track) track.scrollLeft = 0; setTimelineZoom(1); });
  timelineTrack.addEventListener("wheel", e => { e.preventDefault(); setTimelineZoom(state.timelineZoom * (e.deltaY < 0 ? 1.25 : .8), e.clientX - timelineTrack.getBoundingClientRect().left); }, { passive:false });

  let scanShownOnce = false;
  function setScanStatus(key) {
    const label = document.querySelector(".scan-status [data-i18n]");
    if (!label) return;
    label.dataset.i18n = key;
    label.textContent = ts(key);
  }
  function scanFailed(errorValue) {
    updateScanLoading(null);
    setScanStatus("scan.failed");
    fail(errorValue);
  }
  function updateScanLoading(p) {
    const overlay = $("scan-loading");
    if (!overlay) return;
    if (!p || p.stage === "READY") { overlay.hidden = true; return; }
    overlay.hidden = false; scanShownOnce = true;
    const pct = p.total > 0 ? Math.max(2, Math.min(99, Math.round(p.completed / p.total * 100))) : 5;
    $("scan-loading-fill").style.width = pct + "%";
    $("scan-loading-text").textContent = ts("scan.stage." + p.stage);
  }
  api.onScanProgress && api.onScanProgress(p => { const title = $("device-title"); if (title) title.textContent = ts("scan.stage." + p.stage) + " " + p.completed + "/" + p.total; if (p && p.stage !== "READY") setScanStatus("scan.running"); updateScanLoading(p); });
  api.onPreviewProgress && api.onPreviewProgress(p => { if (!p || !state.asset || p.assetId !== state.asset.id) return; if (p.pct >= 100) { if (state.mode === "edit") videoReady(); else hideGenerating(); return; } showGenerating(p.pct); });
  api.onPreviewFrame && api.onPreviewFrame(frame => {
    if (!state.asset || !frame || frame.assetId !== state.asset.id || state.mode !== "edit") return;
    // The hidden video remains the audio/timeline clock. If IPC or canvas paint
    // stalls, do not display frames that are already materially behind it.
    // Late frames are dropped, slightly early frames are held for the clock to
    // catch up, and a pipe that has diverged past recovery is relaunched. The
    // resync case is what stops the canvas freezing: the decoder runs at
    // -readrate above 1x and every dropped frame pushes the reported source time
    // further ahead, so skew grows without bound and holding never terminates.
    const decision = previewClock.frameDecision({
      frameSourceTime: frame.sourceTime,
      clockSourceTime: video.currentTime,
      lagOffset: previewLag.offset,
      // A launch hold is about to be released, so the clock will advance in a
      // moment. Reporting it as paused would force-accept the frame and defeat
      // the alignment the hold exists to create.
      paused: video.paused && !clockHeldForLaunch
    });
    if (decision.action === "drop") {
      // Learn from the drop. ffmpeg's spawn delay puts the pipe a constant
      // distance behind the clock, and without measuring it every frame is late
      // by that same amount and the canvas never paints anything at all.
      previewLag.observe(decision.rawSkew);
      return;
    }
    if (decision.action === "hold") {
      pendingEarlyFrame = frame;
      // Must still schedule a paint: this is the only path that can later
      // release the held frame. Returning without it strands the canvas.
      queuePreviewPaint();
      return;
    }
    if (decision.action === "resync") {
      pendingEarlyFrame = null;
      const now = Date.now();
      if (previewClock.resyncAllowed(lastPreviewResyncAt, now)) {
        lastPreviewResyncAt = now;
        // The relaunch gives the pipe a new baseline, so the old measurement is
        // stale and would otherwise be applied to frames it does not describe.
        previewLag.reset();
        api.renderPreviewSeek && api.renderPreviewSeek({ assetId: state.asset.id, timelineSeconds: previewTimelineSeconds(state.editor) });
        return;
      }
      // Inside the cooldown, keep the canvas alive with the frame in hand rather
      // than discarding it and showing nothing.
    }
    pendingEarlyFrame = null;
    // In-window frames prove the pipe is keeping up, so stop accruing lag
    // evidence; only an unbroken run of late frames may set the baseline.
    previewLag.noteHealthy();
    // A frame accepted in-window means the relaunch recovered, so the budget is
    // restored. Without this a long clip would exhaust it across normal playback.
    previewEndedRestarts = 0;
    latestPreviewFrame = frame; previewFrameDirty = true;
    notifyPreviewGeneration(frame);
    // The first frame of a launch arrives unGated by design; re-arm the clock
    // feedback now so the gate closes for the frames that follow it.
    invalidateReportedClock();
    videoReady();
    canvas.hidden = false;
    // Coalesce IPC bursts into one canvas paint. RGB24 -> RGBA conversion and
    // putImageData are synchronous; painting every incoming 60fps frame can
    // starve the hidden video clock and make playback appear to change speed.
    queuePreviewPaint();
    // Only idle the decoder for a player the *user* left paused. During a launch
    // hold the clock is paused by us and the pipe is still needed, so pausing it
    // here would kill the process this very frame came from and freeze the canvas.
    if (previewEntryPaused && video.paused && !clockHeldForLaunch) { previewEntryPaused = false; api.renderPreviewPause({ assetId: state.asset.id }); }
  });
  api.onPreviewEnded && api.onPreviewEnded(details => {
    if (!details || !state.asset || details.assetId !== state.asset.id || state.mode !== "edit") return;
    // A held-back early frame is the last thing the drain produced; with no
    // further frames coming, the skew check would strand it on screen forever.
    if (pendingEarlyFrame) { latestPreviewFrame = pendingEarlyFrame; previewFrameDirty = true; pendingEarlyFrame = null; queuePreviewPaint(); }
    const endedAt = Number(details.sourceTime);
    const clock = Number(video.currentTime);
    const atClipEnd = video.ended || !Number.isFinite(endedAt) || !Number.isFinite(clock) || endedAt - clock <= PREVIEW_SKEW_TOLERANCE * 2;
    // ffmpeg stopped ahead of the audio clock, so playback is not actually over.
    // Relaunch from the clock instead of leaving a frozen canvas. The attempt
    // counter stops a truncated or unreadable tail from looping forever.
    if (!atClipEnd && !video.paused && previewEndedRestarts < PREVIEW_ENDED_RESTART_LIMIT) {
      previewEndedRestarts++;
      api.renderPreviewResume && api.renderPreviewResume({ assetId: state.asset.id, timelineSeconds: previewTimelineSeconds(state.editor) });
      return;
    }
    previewEndedRestarts = 0;
    if (!video.paused) video.pause();
    setStateBadge(ts("preview.liveEffects"), true, "preview.liveEffects");
  });
  api.onPreviewError && api.onPreviewError(details => {
    if (!details || !state.asset || details.assetId !== state.asset.id || state.mode !== "edit") return;
    // Keep the last valid frame visible when a superseded ffmpeg process exits
    // during a rapid control change. A transient process failure should never
    // turn a usable preview into a blank canvas.
    if (!latestPreviewFrame) canvas.hidden = true;
    setStateBadge("", false);
    const message = String(details.message || "");
    showError(message.length > 240 ? message.slice(-240) : message, true);
  });
  api.onExportProgress && api.onExportProgress(progress => {
    if (!progress || progress.assetId !== exportingAssetId) return;
    // Two distinct messages share this channel: the destination is announced
    // once before encoding starts, then percentages stream in. Treating a
    // destination-only message as a percentage would show a false 0%.
    if (progress.destination !== undefined) {
      updateExportModal(progress.assetId, previous => exportModalState.applyDestination(previous, progress.destination));
      return;
    }
    if (progress.pct === undefined || progress.pct === null) return;
    const pct = Math.max(0, Math.min(100, Number(progress.pct) || 0));
    updateExportModal(progress.assetId, previous => exportModalState.applyProgress(previous, pct));
    if (!state.asset || state.asset.id !== progress.assetId) return;
    $("export-progress").hidden = false;
    $("export-progress-fill").style.width = pct + "%";
    $("export-status").textContent = ts("export.progress", { pct: Math.round(pct) });
  });
  retryPreview && retryPreview.addEventListener("click", () => {
    hideError();
    if (state.asset && state.mode === "edit") edit();
    else if (state.asset) browse();
  });
  api.onSnapshot(snapshot => { const overlay = $("scan-loading"); if (overlay) overlay.hidden = true; setScanStatus("scan.completed"); const selected = state.asset && state.asset.id; render(snapshot); if (selected && state.asset && snapshot.assets.some(a => a.id === selected)) { state.asset = snapshot.assets.find(a => a.id === selected); updateNavigation(); paintGrid(); } });
  api.onLocalSnapshot && api.onLocalSnapshot(renderLocal);
  // Export progress dialog. The sidebar bar stays in place as the compact
  // indicator; the dialog is the detailed view with cover, destination and size.
  let exportModal = null;
  function paintExportModal() {
    const overlay = $("export-overlay");
    if (!overlay) return;
    if (!exportModal) { overlay.hidden = true; return; }
    const model = exportModalState.view(exportModal);
    overlay.hidden = false;
    $("export-modal-name").textContent = model.title;
    const destination = $("export-modal-destination");
    destination.textContent = model.destinationName || model.destination || ts("color.unknown");
    destination.title = model.destination;
    $("export-modal-size").textContent = model.sizeText ? (model.sizeIsEstimate ? ts("exportModal.sizeEstimate", { size: model.sizeText }) : model.sizeText) : ts("color.unknown");
    const progress = $("export-modal-progress");
    progress.classList.toggle("indeterminate", model.indeterminate);
    $("export-modal-fill").style.width = model.indeterminate ? "100%" : model.barWidth;
    $("export-modal-status").textContent = model.phase === "error" ? ts("exportModal.failed") + " " + model.errorMessage : ts(model.statusKey, model.statusParams || {});
    $("export-modal-pct").textContent = model.percentText;
    $("export-modal-cancel").hidden = model.cancelHidden;
    $("export-modal-close").hidden = model.closeHidden;
    $("export-modal-reveal").hidden = model.revealHidden;
    const cover = $("export-modal-cover");
    if (model.coverUrl && cover.dataset.url !== model.coverUrl) {
      cover.dataset.url = model.coverUrl;
      const img = new Image(); img.alt = ""; img.src = model.coverUrl;
      cover.replaceChildren(img);
    } else if (!model.coverUrl && cover.dataset.url) {
      delete cover.dataset.url; cover.replaceChildren();
    }
  }
  function updateExportModal(assetId, transform) {
    if (!exportModal || exportModal.assetId !== assetId) return;
    exportModal = transform(exportModal);
    paintExportModal();
  }
  function openExportModal(asset, editor) {
    const probe = (asset.original && asset.original.probe) || {};
    const audioBitrate = probe.audio && probe.audio.bitrate !== "UNKNOWN" ? probe.audio.bitrate : null;
    const durationSeconds = editorUiState.exportDurationSeconds(editor && editor.clip, probe.duration !== "UNKNOWN" ? probe.duration : 0);
    exportModal = exportModalState.initialState({
      assetId: asset.id,
      assetName: asset.original ? asset.original.name : "",
      destination: "",
      durationSeconds,
      estimatedBytes: exportModalState.estimateOutputBytes({ durationSeconds, videoBitrate: probe.bitrate !== "UNKNOWN" ? probe.bitrate : null, audioBitrate })
    });
    paintExportModal();
    // Reuse the grid thumbnail so the dialog cover costs no extra decode.
    const cached = thumbCache.get(thumbKey(asset.id)) || thumbCache.get(asset.id + "@231");
    if (cached) updateExportModal(asset.id, previous => exportModalState.applyCover(previous, cached));
    else api.getThumbnailUrl(asset.id, THUMB_TIERS.poster).then(result => { const url = result && (result.url || result); if (url) updateExportModal(asset.id, previous => exportModalState.applyCover(previous, url)); }).catch(() => {});
  }
  function closeExportModal() { exportModal = null; paintExportModal(); }
  $("export-modal-close") && $("export-modal-close").addEventListener("click", closeExportModal);
  $("export-modal-cancel") && $("export-modal-cancel").addEventListener("click", async () => {
    if (!exportingAssetId) return;
    $("export-modal-cancel").disabled = true;
    try { await api.cancelExport(); } catch (e) { fail(e); }
    finally { $("export-modal-cancel").disabled = false; }
  });
  $("export-modal-reveal") && $("export-modal-reveal").addEventListener("click", () => {
    if (exportModal && exportModal.destination) api.revealPath(exportModal.destination);
  });

  // ---- Badge picker ----
  // One control serves the editor's Watermark section and the batch sheet: a
  // button showing the chosen badge, opening a grouped list where every row
  // carries its own preview. The native <select> stays in the DOM as the value
  // holder, so the change plumbing that already exists keeps working.
  function badgeLabel(entry) { return entry ? badgePicker.variantLabel(entry.variant, ts) : ts("watermark.none"); }
  function mountBadgePicker(hostId, selectId, sources, enableId) {
    const host = $(hostId), select = $(selectId);
    if (!host || !select || !badgePicker) return { refresh() {}, close() {} };
    const button = document.createElement("button"); button.type = "button"; button.className = "badge-picker"; button.setAttribute("aria-haspopup", "listbox"); button.setAttribute("aria-expanded", "false");
    const preview = document.createElement("img"); preview.className = "badge-preview"; preview.alt = ""; preview.hidden = true;
    const name = document.createElement("span"); name.className = "badge-picker-name";
    const chevron = document.createElement("span"); chevron.className = "badge-chevron"; chevron.dataset.icon = "more";
    button.append(preview, name, chevron);
    const menu = document.createElement("div"); menu.className = "badge-menu"; menu.hidden = true; menu.setAttribute("role", "listbox");
    host.append(button, menu);
    function close() { menu.hidden = true; button.setAttribute("aria-expanded", "false"); }
    // Choosing a badge is choosing to have one: picking a style while the
    // watermark is switched off turns it on, so the choice is never swallowed.
    function pick(id) {
      select.value = id;
      const enable = enableId ? $(enableId) : null;
      if (enable && id !== "none" && !enable.checked) { enable.checked = true; enable.dispatchEvent(new Event("change", { bubbles: true })); }
      select.dispatchEvent(new Event("change", { bubbles: true }));
      close();
      refresh();
    }
    function row(entry) {
      const item = document.createElement("button"); item.type = "button"; item.className = "badge-row"; item.setAttribute("role", "option"); item.dataset.id = entry.id;
      if (entry.url) { const img = document.createElement("img"); img.className = "badge-preview"; img.src = entry.url; img.alt = ""; img.loading = "lazy"; item.appendChild(img); }
      const text = document.createElement("span"); text.className = "badge-row-name"; text.textContent = badgePicker.tileLabel(entry.variant, ts);
      item.appendChild(text);
      item.title = entry.familyName + " \u00b7 " + badgeLabel(entry);
      item.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); pick(entry.id); });
      return item;
    }
    function refresh() {
      const available = sources() || {};
      const groups = badgePicker.sections(available);
      // The select is the value the editor reads, so it must accept every badge
      // on offer -- not only the clip's own device -- or a badge picked from
      // another group would silently blank the selection.
      const offered = [];
      for (const group of groups) for (const entry of group.entries) offered.push(entry);
      const previous = select.value;
      select.replaceChildren(new Option(ts("watermark.none"), "none"));
      for (const entry of offered) select.appendChild(new Option((entry.familyName ? entry.familyName + " " : "") + badgeLabel(entry), entry.id));
      if (previous !== "none" && !offered.some(entry => entry.id === previous)) select.value = offered.length ? offered[0].id : "none";
      else select.value = previous;
      menu.replaceChildren();
      // "No watermark" is a real choice, so it is a row like any other.
      const none = document.createElement("button"); none.type = "button"; none.className = "badge-row"; none.dataset.id = "none"; none.setAttribute("role", "option");
      const noneText = document.createElement("span"); noneText.className = "badge-row-name"; noneText.textContent = ts("watermark.none");
      none.appendChild(noneText);
      none.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); pick("none"); });
      menu.appendChild(none);
      let tileIndex = 0;
      for (const group of groups) {
        const head = document.createElement("div"); head.className = "badge-group"; head.textContent = group.name;
        menu.appendChild(head);
        for (const entry of group.entries) { const tile = row(entry); tile.style.setProperty("--i", String(tileIndex++)); menu.appendChild(tile); }
      }
      const current = badgePicker.findEntry(select.value, available);
      preview.hidden = !(current && current.url);
      if (current && current.url) preview.src = current.url;
      name.textContent = badgeLabel(current);
      name.title = current ? current.familyName + " \u00b7 " + badgeLabel(current) : ts("watermark.none");
      for (const item of menu.querySelectorAll(".badge-row")) item.classList.toggle("active", item.dataset.id === select.value);
    }
    button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); const opening = menu.hidden; menu.hidden = !opening; button.setAttribute("aria-expanded", opening ? "true" : "false"); if (opening) { menu.classList.add("settle"); setTimeout(() => menu.classList.remove("settle"), 520); const active = menu.querySelector(".badge-row.active"); if (active) active.scrollIntoView({ block: "nearest" }); } });
    menu.addEventListener("click", event => event.stopPropagation());
    document.addEventListener("click", () => { if (!menu.hidden) close(); });
    host.addEventListener("keydown", event => { if (event.key === "Escape" && !menu.hidden) { close(); button.focus(); } });
    return { refresh, close };
  }
  const editorBadgePicker = mountBadgePicker("watermark-picker-host", "watermark", () => ({ matched: state.watermarkMatched || [], catalog: state.watermarkCatalog || [] }), "watermark-enable");
  const batchBadgePicker = mountBadgePicker("batch-watermark-picker-host", "batch-option-watermark-id", () => ({ matched: (batchOptions && batchOptionsState.view(batchOptions).watermarks) || [], catalog: batchCatalog }), "batch-option-watermark");

  // ---- Rail widths ----
  // Drag the seam beside the media library or the inspector to resize it. The
  // width is remembered between sessions; double-click restores the shipped
  // width, and the arrows nudge it when the seam has focus.
  (function mountRailSplitters() {
    const workspace = document.querySelector(".workspace");
    if (!workspace) return;
    const KEY = "dji-osmo-desktop-v2.rail-widths";
    const bounds = { nav: [244, 620], insp: [244, 620] };
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { saved = {}; }
    const root = document.documentElement;
    if (Number(saved.nav)) root.style.setProperty("--nav-w", saved.nav + "px");
    if (Number(saved.insp)) root.style.setProperty("--insp-w", saved.insp + "px");
    const mount = (side, variable, shipped) => {
      const handle = document.createElement("div");
      handle.className = "rail-splitter " + side;
      handle.tabIndex = 0;
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-orientation", "vertical");
      handle.setAttribute("aria-label", side === "nav" ? ts("library.title") : ts("aria.inspector"));
      workspace.appendChild(handle);
      const current = () => parseFloat(getComputedStyle(root).getPropertyValue(variable)) || shipped;
      const apply = (value, remember) => {
        const [low, high] = bounds[side];
        const width = Math.min(high, Math.max(low, Math.round(value)));
        root.style.setProperty(variable, width + "px");
        // The panels were resized, so the grid has to lay itself out again
        // instead of keeping the positions from the old width.
        window.dispatchEvent(new Event("resize"));
        if (remember) { saved[side] = width; try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* private mode */ } }
      };
      handle.addEventListener("pointerdown", event => {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        handle.classList.add("dragging");
        const startX = event.clientX;
        const startWidth = current();
        const move = moveEvent => apply(startWidth + (side === "nav" ? 1 : -1) * (moveEvent.clientX - startX), false);
        const finish = () => {
          handle.classList.remove("dragging");
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", finish);
          handle.removeEventListener("pointercancel", finish);
          apply(current(), true);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", finish);
        handle.addEventListener("pointercancel", finish);
      });
      handle.addEventListener("dblclick", () => apply(shipped, true));
      handle.addEventListener("keydown", event => {
        const step = event.shiftKey ? 32 : 8;
        if (event.key === "ArrowLeft") apply(current() + (side === "nav" ? -step : step), true);
        else if (event.key === "ArrowRight") apply(current() + (side === "nav" ? step : -step), true);
        else return;
        event.preventDefault();
      });
    };
    mount("nav", "--nav-w", 344);
    mount("insp", "--insp-w", 312);
  })();

  // ---- Batch export ----
  // The main process owns the queue; this only renders its snapshots. Rows are
  // reconciled by id rather than rebuilt, because a fifty-clip batch emits a
  // progress event per percent per clip and rebuilding the list each time would
  // be thousands of DOM writes.
  let batchModal = null;
  // The badge catalogue the sheet was opened with, for the picker's "other
  // devices" half.
  let batchCatalog = [];
  // Setup-phase state, separate from the queue snapshot: it owns the two
  // decisions the user makes before any work is queued.
  let batchOptions = null;
  // Video specification choices survive between batch dialogs in one session;
  // the defaults are "source / quality / 8-bit", i.e. the single-export path.
  let videoOptions = videoOptionsState ? videoOptionsState.initialState() : null;
  // The clip inspector keeps its own spec: a batch's resolution choice is not a
  // statement about the clip that happens to be open.
  let exportOptions = videoOptionsState ? videoOptionsState.initialState() : null;
  const batchRowNodes = new Map();
  function renderBatchRows(items) {
    const list = $("batch-modal-list");
    if (!list) return;
    const active = new Set();
    for (const item of items) {
      let node = batchRowNodes.get(item.id);
      if (!node) {
        const row = document.createElement("div"); row.className = "batch-row"; row.setAttribute("role", "listitem");
        const name = document.createElement("span"); name.className = "batch-row-name";
        // A still and a clip share a row shape but not a pipeline, so the row
        // says which one it is instead of leaving the user to guess from the
        // extension.
        const tag = document.createElement("span"); tag.className = "batch-pick-tag"; tag.hidden = true;
        const bar = document.createElement("div"); bar.className = "batch-row-bar";
        const fill = document.createElement("div"); fill.className = "batch-row-fill";
        bar.appendChild(fill);
        const stateText = document.createElement("span"); stateText.className = "batch-row-state";
        row.append(name, tag, bar, stateText);
        node = { row, name, tag, fill, stateText };
        batchRowNodes.set(item.id, node);
        list.appendChild(row);
      }
      node.name.textContent = item.name;
      node.name.title = item.destination;
      node.tag.hidden = item.isPhoto !== true;
      if (item.isPhoto) node.tag.textContent = ts("batchExport.tagPhoto");
      node.fill.style.width = item.barWidth;
      // The reason lives in the tooltip: rows stay one line each so a fifty-clip
      // batch remains scannable.
      node.stateText.textContent = item.percentText || ts(item.statusKey);
      node.stateText.title = item.errorMessage || "";
      node.row.classList.toggle("failed", item.failed === true);
      node.row.classList.toggle("done", item.state === "done");
      // A running row with no percentage yet gets a sweeping bar instead of a
      // frozen empty track, so the first seconds of a transcode read as work.
      node.row.classList.toggle("indeterminate", item.indeterminate === true);
      active.add(item.id);
    }
    for (const [id, node] of batchRowNodes) { if (!active.has(id)) { node.row.remove(); batchRowNodes.delete(id); } }
  }
  function paintBatchModal(patch = {}) {
    const overlay = $("batch-overlay");
    if (!overlay) return;
    if (!batchModal) { overlay.hidden = true; return; }
    const model = batchExportState.view(batchModal);
    overlay.hidden = false;
    $("batch-modal-headline").textContent = ts(model.headlineKey, model.headlineParams);
    $("batch-modal-count").textContent = model.skipped
      ? ts("batchExport.summarySkipped", { done: model.counts.done, total: model.counts.total, skipped: model.skipped })
      : model.summaryText;
    const destination = $("batch-modal-destination");
    if (destination) { destination.textContent = batchModal.destination || ""; destination.title = batchModal.destination || ""; }
    $("batch-modal-fill").style.width = model.overallWidth;
    $("batch-modal-progress").classList.toggle("indeterminate", !model.settled && model.overallPercent <= 0);
    $("batch-modal-cancel").hidden = model.cancelHidden;
    $("batch-modal-close").hidden = model.closeHidden;
    $("batch-modal-reveal").hidden = model.revealHidden || patch.revealHidden === true;
    renderBatchRows(model.items);
  }
  function closeBatchModal() {
    batchModal = null;
    batchOptions = null;
    batchCatalog = [];
    batchBadgePicker.close();
    for (const [, node] of batchRowNodes) node.row.remove();
    batchRowNodes.clear();
    const setupList = $("batch-setup-list");
    if (setupList) setupList.replaceChildren();
    paintBatchModal();
  }
  // The dialog has two phases in one shell: the setup sheet decides what the
  // batch will do, then the queue's progress replaces it. Keeping both in one
  // dialog means the user confirms and watches in the same place.
  function openBatchDialog(phase) {
    const overlay = $("batch-overlay");
    if (!overlay) return;
    overlay.hidden = false;
    const setup = phase === "setup";
    const setupPanel = $("batch-setup");
    const progressPanel = $("batch-progress");
    if (setupPanel) setupPanel.hidden = !setup;
    if (progressPanel) progressPanel.hidden = setup;
    if (setup) paintBatchSetup();
  }
  function renderBatchSetupRows(clips) {
    const list = $("batch-setup-list");
    if (!list) return;
    list.replaceChildren();
    for (const clip of clips) {
      const row = document.createElement("div"); row.className = "batch-pick-row"; row.setAttribute("role", "listitem");
      const name = document.createElement("span"); name.className = "batch-pick-name"; name.textContent = clip.name; name.title = clip.name;
      row.appendChild(name);
      if (clip.isPhoto) {
        const tag = document.createElement("span"); tag.className = "batch-pick-tag"; tag.textContent = ts("batchExport.tagPhoto");
        row.appendChild(tag);
      }
      if (clip.showRestore) {
        const tag = document.createElement("span"); tag.className = "batch-pick-tag"; tag.textContent = ts("batchExport.tagRestore");
        row.appendChild(tag);
      }
      list.appendChild(row);
    }
  }
  // The batch sheet and the clip inspector ask the same questions, so they are
  // painted and bound by the same two helpers; only the id prefix differs.
  function paintVideoSpecControls(prefix, model) {
    const fill = (id, entries, value) => {
      const select = $(id);
      if (!select) return;
      const signature = entries.map(entry => entry.value).join(",");
      if (select.dataset.signature !== signature) {
        select.replaceChildren();
        for (const entry of entries) select.appendChild(new Option(ts(entry.labelKey), entry.value));
        select.dataset.signature = signature;
      }
      select.value = value;
    };
    fill(prefix + "-option-resolution", model.resolutions, model.resolution);
    fill(prefix + "-option-fps", model.frameRates, model.fps);
    fill(prefix + "-option-rate", model.rateModes, model.rate);
    fill(prefix + "-option-codec", model.codecs, model.codec);
    const bitrateRow = $(prefix + "-bitrate-row");
    if (bitrateRow) bitrateRow.hidden = !model.bitrateVisible;
    const bitrate = $(prefix + "-option-bitrate");
    if (bitrate) bitrate.value = String(model.bitrateMbps);
    const tenBit = $(prefix + "-option-tenbit");
    if (tenBit) { tenBit.checked = model.tenBit; tenBit.disabled = model.tenBitDisabled; }
  }
  function bindVideoSpecControls(prefix, mutate) {
    const bind = (suffix, event, handler) => { const control = $(prefix + "-option-" + suffix); if (control) control.addEventListener(event, handler); };
    bind("resolution", "change", event => mutate(current => videoOptionsState.setResolution(current, event.target.value)));
    bind("fps", "change", event => mutate(current => videoOptionsState.setFps(current, event.target.value)));
    bind("rate", "change", event => mutate(current => videoOptionsState.setRate(current, event.target.value)));
    bind("codec", "change", event => mutate(current => videoOptionsState.setCodec(current, event.target.value)));
    bind("bitrate", "change", event => mutate(current => videoOptionsState.setBitrate(current, event.target.value)));
    bind("tenbit", "change", event => mutate(current => videoOptionsState.setTenBit(current, event.target.checked)));
  }
  function paintVideoSpec() {
    if (!videoOptions || !videoOptionsState) return;
    paintVideoSpecControls("batch", videoOptionsState.view(videoOptions));
  }
  function updateVideoOptions(mutate) {
    if (!videoOptions || !videoOptionsState) return;
    const next = mutate(videoOptions);
    if (next === videoOptions) return;
    videoOptions = next;
    paintVideoSpec();
  }
  function paintExportSpec() {
    if (!videoOptionsState) return;
    if (!exportOptions) exportOptions = videoOptionsState.initialState();
    paintVideoSpecControls("export", videoOptionsState.view(exportOptions));
    // The primary button names the container it will write, so the codec choice
    // is visible without opening the section.
    const label = $("export-button") && $("export-button").querySelector("span");
    if (label) label.textContent = ts(exportOptions.codec === "hevc" ? "export.buttonHevc" : "export.buttonH264");
  }
  function updateExportOptions(mutate) {
    if (!exportOptions || !videoOptionsState) return;
    const next = mutate(exportOptions);
    if (next === exportOptions) return;
    exportOptions = next;
    paintExportSpec();
  }
  function exportSpecPayload() {
    return videoOptionsState && exportOptions ? videoOptionsState.payload(exportOptions) : undefined;
  }
  function paintBatchSetup() {
    if (!batchOptions) return;
    const model = batchOptionsState.view(batchOptions);
    $("batch-setup-headline").textContent = ts(model.headlineKey, { count: model.restoreCount, model: ts(model.colorModeKey) });
    // Photos and unreadable entries are dropped before the dialog is built, so
    // the count has to own up to the gap or the list looks short for no reason.
    $("batch-setup-count").textContent = model.skipped
      ? ts("batchExport.setupCountSkipped", { total: model.total, skipped: model.skipped })
      : ts("batchExport.setupCount", { total: model.total });
    const destination = $("batch-setup-destination");
    if (destination) { destination.textContent = model.destination || ""; destination.title = model.destination || ""; }
    const colorMode = $("batch-option-color-mode");
    if (colorMode) colorMode.value = model.colorMode;
    const watermarkBox = $("batch-option-watermark");
    watermarkBox.checked = model.watermarkEnabled;
    watermarkBox.disabled = model.watermarks.length === 0;
    const select = $("batch-option-watermark-id");
    if (select) {
      // Rebuild only when the badge set changes; replacing the options on every
      // paint would close the dropdown while the user is choosing from it.
      if (select.dataset.signature !== model.watermarkSignature) {
        select.replaceChildren();
        for (const entry of model.watermarks) select.appendChild(new Option(entry.familyName + " " + badgePicker.variantLabel(entry.variant, ts), entry.id));
        select.dataset.signature = model.watermarkSignature;
      }
      select.disabled = !model.watermarkEnabled;
      select.value = model.watermarkId || "";
      batchBadgePicker.refresh();
    }
    renderBatchSetupRows(model.clips);
    $("batch-setup-start").disabled = model.startDisabled;
    paintVideoSpec();
  }
  // The setup sheet is built from the main process's own view of the selection
  // so the clips it marks D-Log are exactly the clips export will restore.
  async function openBatchSetup() {
    if (!batchIds.size || batchOptions || batchModal) return;
    hideError();
    const requested = [...batchIds];
    $("selection-export").disabled = true;
    try {
      const setup = await api.batchSetup({ assetIds: requested });
      if (!setup || !Array.isArray(setup.clips) || !setup.clips.length) { showError(ts("batchExport.nothingToExport"), false); return; }
      batchOptions = batchOptionsState.initialState({ clips: setup.clips, watermarks: setup.watermarks, destination: setup.destination, skipped: setup.skipped });
      batchCatalog = Array.isArray(setup.watermarkCatalog) ? setup.watermarkCatalog : [];
      openBatchDialog("setup");
    } catch (e) {
      fail(e);
    } finally {
      $("selection-export").disabled = false;
      renderLibraryPanel();
    }
  }
  async function confirmBatchExport() {
    if (!batchOptions || !batchIds.size) return;
    const model = batchOptionsState.view(batchOptions);
    $("batch-setup-start").disabled = true;
    try {
      const result = await api.exportBatch({ assetIds: [...batchIds], colorMode: model.colorMode, watermark: model.watermark, videoSpec: videoOptionsState && videoOptions ? videoOptionsState.payload(videoOptions) : null });
      if (!result || result.canceled) return;
      if (!result.queued) { closeBatchModal(); showError(ts("batchExport.nothingToExport"), false); return; }
      batchModal = batchExportState.initialState({ batchId: result.batchId, destination: result.destination || "", items: result.items || [], skipped: result.skipped || 0 });
      batchOptions = null;
      clearBatchSelection();
      openBatchDialog("progress");
      paintBatchModal();
    } catch (e) {
      fail(e);
    } finally {
      $("batch-setup-start").disabled = false;
    }
  }
  // A single entry point for the option controls. The pure state returns the
  // same object when nothing changed, so an idempotent change never repaints.
  function updateBatchOptions(mutate) {
    if (!batchOptions) return;
    const next = mutate(batchOptions);
    if (next === batchOptions) return;
    batchOptions = next;
    paintBatchSetup();
  }
  $("selection-export") && $("selection-export").addEventListener("click", openBatchSetup);
  $("selection-clear") && $("selection-clear").addEventListener("click", clearBatchSelection);
  // The inspector's library block drives the same selection as the floating bar,
  // so batch export is discoverable without first clicking a checkbox.
  $("library-export-selected") && $("library-export-selected").addEventListener("click", openBatchSetup);
  // Select all: the list toolbar button, the inspector button and Ctrl/Cmd+A all
  // drive the same toggle.
  $("selection-all") && $("selection-all").addEventListener("click", () => toggleSelectAll());
  $("library-select-all") && $("library-select-all").addEventListener("click", () => toggleSelectAll());
  document.addEventListener("keydown", event => {
    if (event.key !== "a" && event.key !== "A") return;
    if (!event.ctrlKey && !event.metaKey) return;
    // Only browse owns the list. In the editor a text field's own select-all has
    // to win, and space/arrows already belong to the player.
    if (state.mode !== "browse") return;
    const target = event.target;
    if (target && target.closest && target.closest("input, select, textarea, [contenteditable='true']")) return;
    event.preventDefault();
    toggleSelectAll();
  });
  $("library-choose-destination") && $("library-choose-destination").addEventListener("click", async () => {
    try {
      const directory = await api.chooseExportLocation();
      if (!directory) return;
      state.settings = { ...(state.settings || {}), exportLocation: directory };
      const field = $("settings-export-location");
      if (field) field.value = directory;
      renderLibraryPanel();
    } catch (error) { fail(error); }
  });
  $("batch-setup-cancel") && $("batch-setup-cancel").addEventListener("click", closeBatchModal);
  $("batch-setup-start") && $("batch-setup-start").addEventListener("click", confirmBatchExport);
  $("batch-option-color-mode") && $("batch-option-color-mode").addEventListener("change", event => updateBatchOptions(current => batchOptionsState.setColorMode(current, event.target.value)));
  $("batch-option-watermark") && $("batch-option-watermark").addEventListener("change", event => updateBatchOptions(current => batchOptionsState.setWatermarkEnabled(current, event.target.checked)));
  $("batch-option-watermark-id") && $("batch-option-watermark-id").addEventListener("change", event => updateBatchOptions(current => batchOptionsState.setWatermarkId(current, event.target.value)));
  bindVideoSpecControls("batch", mutate => updateVideoOptions(mutate));
  bindVideoSpecControls("export", mutate => updateExportOptions(mutate));
  $("batch-modal-close") && $("batch-modal-close").addEventListener("click", closeBatchModal);
  $("batch-modal-cancel") && $("batch-modal-cancel").addEventListener("click", async () => {
    if (!batchModal || !batchModal.batchId) return;
    $("batch-modal-cancel").disabled = true;
    try { await api.cancelExportBatch({ batchId: batchModal.batchId }); } catch (e) { fail(e); }
    finally { $("batch-modal-cancel").disabled = false; }
  });
  $("batch-modal-reveal") && $("batch-modal-reveal").addEventListener("click", () => {
    if (!batchModal) return;
    // shell:reveal-path only accepts an existing file, so point it at the first
    // completed export rather than the destination folder.
    const done = batchModal.items.find(item => item.state === "done" && item.destination);
    if (done) api.revealPath(done.destination);
  });
  api.onExportBatchUpdate && api.onExportBatchUpdate(items => {
    if (!batchModal) return;
    const next = batchExportState.applyQueueUpdate(batchModal, items);
    // Referentially identical means nothing visible changed; skip the paint.
    if (next === batchModal) return;
    batchModal = next;
    paintBatchModal();
  });

  async function runExport(exportAs) {
    if (!state.asset || !state.editor || state.asset.mediaKind === "photo" || exportingAssetId) return;
    hideError();
    const assetId = state.asset.id;
    const editor = editorFromControls(); state.editor = editor;
    exportingAssetId = assetId;
    $("export-progress").hidden = false; $("export-progress-fill").style.width = "0%"; $("export-status").textContent = ts("export.running"); $("export-cancel-button").disabled = false; $("export-cancel-button").hidden = false;
    openExportModal(state.asset, editor);
    setAssetControls(state.asset);
    try {
      const result = exportAs ? await api.exportEditAs({ assetId, editor, videoSpec: exportSpecPayload() }) : await api.exportEdit({ assetId, editor, videoSpec: exportSpecPayload() });
      if (result && result.canceled) updateExportModal(assetId, exportModalState.applyCanceled);
      else updateExportModal(assetId, previous => exportModalState.applyDone(previous, result || {}));
      if (state.asset && state.asset.id === assetId) $("export-status").textContent = result.canceled ? ts("export.canceled") : ts("export.done", { path: result.outputPath || "" });
    } catch (e) {
      const canceled = editorUiState.isExportCanceledError(e);
      updateExportModal(assetId, previous => canceled ? exportModalState.applyCanceled(previous) : exportModalState.applyError(previous, e && e.message ? e.message : String(e)));
      if (state.asset && state.asset.id === assetId) {
        if (canceled) $("export-status").textContent = ts("export.canceled");
        else { $("export-status").textContent = ""; fail(e); }
      }
    } finally {
      if (exportingAssetId === assetId) exportingAssetId = null;
      if (state.asset && state.asset.id === assetId) $("export-progress").hidden = true;
      $("export-cancel-button").hidden = true;
      $("export-cancel-button").disabled = false;
      setAssetControls(state.asset);
    }
  }
  $("export-button").addEventListener("click", () => runExport(false));
  $("export-as-button").addEventListener("click", () => runExport(true));
  $("export-cancel-button").addEventListener("click", async () => {
    if (!exportingAssetId) return;
    $("export-cancel-button").disabled = true;
    try { await api.cancelExport(); } catch (e) { fail(e); }
  });

  // Settings are persisted in the main process; apply the stored language on
  // every launch so the selector and all data-i18n labels cannot drift apart.
  api.getSettings().then(settings => {
    state.settings = settings || {};
    if (window.i18n && (settings.language === "en" || settings.language === "zh-CN") && window.i18n.getLanguage() !== settings.language) window.i18n.setLanguage(settings.language);
    setTimeout(() => { $("language-select").value = window.i18n.getLanguage(); $("settings-language").value = window.i18n.getLanguage(); }, 0);
    // The destination is read from settings, so the panel cannot show it until
    // they arrive.
    renderLibraryPanel();
  }).catch(() => {});
  setAssetControls(null);
  paintSelectionBar();
  // Static markup declares data-icon and receives its glyph here, the same way
  // data-i18n elements receive their copy. Runs before the first paint so the
  // toolbar never shows an empty button. The view buttons are hydrated in the
  // same pass, so their icons exist before setView reads them.
  iconSet.hydrateIcons();
  document.body.classList.toggle("view-poster", state.view === "poster");
  updateScanLoading(null); updateScanLoading({ stage: "DETECTING_STORAGE", completed: 0, total: 1 });
  api.scan().then(snapshot => { setScanStatus("scan.completed"); render(snapshot); }).catch(scanFailed);
  api.getLocalSnapshot().then(renderLocal).catch(() => {});
})();
