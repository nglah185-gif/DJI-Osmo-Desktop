const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain, net, protocol, dialog, shell } = require("electron");
const { WindowsMassStorageDeviceProvider } = require("../device-adapter/windows-mass-storage-device-provider");
const { ReadOnlyMediaAccess } = require("../media-access/read-only-media-access");
const { FfprobeMediaProbe } = require("../media-probe/ffprobe-media-probe");
const { InMemoryMediaCatalog, findAssetInCatalogs } = require("../catalog/in-memory-media-catalog");
const { LrfPreviewSourceResolver } = require("../preview/lrf-preview-source-resolver");
const { isDirectEditCodec, isColorCriticalEditAsset } = require("../preview/preview-mode");
const { MediaPipeline } = require("../media-pipeline");
const { createOfficialLutRegistry } = require("../color/lut-registry");
const { createEditorEffectGraph } = require("../color/editor-effect-graph");
const { technicalTransformFor } = require("../color/auto-restore");
const { ColorRenderService } = require("../renderers/color-render-service");
const { assertSafeExportTarget } = require("../renderers/export-path-safety");
const { PreviewFrameStreamer } = require("../renderers/preview-frame-streamer");
const { createTimelineClip } = require("../editor/timeline");
const { createWatermarkRegistry } = require("../watermark/watermark-registry");
const { createEffectGraph } = require("../color/effect-graph");
const { ensureThumbnail, ensurePoster, resolveCachePath } = require("../thumbnail/thumbnail-loader");
const { ensureFallbackProxy, cancelFallbackProxy, shutdownFallbackProxies } = require("../thumbnail/fallback-proxy");
const { scanLocalDirectory } = require("../local-library/local-scanner");
const { expandSelectedFiles, key: localPathKey } = require("../local-library/selected-files");
const { normalizePathList, addSource, removeSource, isPathInside, sourceSnapshot } = require("../local-library/source-config");
const { ExportQueue } = require("../tasks/export-queue");
const { normalizeVideoSpec } = require("../renderers/video-spec");
const { exportJpeg, captureTimeFor, stampCaptureTime } = require("../renderers/jpeg-export");
const { ConfigStore } = require("../settings/config-store");
const { ThumbnailLocator } = require("../thumbnail/thumbnail-locator");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { Readable } = require("node:stream");

// Prevent repeated `dsh web`/development launches from sharing one Chromium
// profile. A second process can otherwise race the first one and corrupt its
// cache/profile, which presents to users as intermittent blank pages or hangs.
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  console.error("DJI Osmo Desktop is already running; close the existing window before starting another instance.");
  app.whenReady().then(() => { dialog.showMessageBoxSync({ type: "warning", title: "DJI Osmo Desktop", message: "DJI Osmo Desktop 已经在运行。请切换到已有窗口，或先关闭已有实例后再启动。" }); app.quit(); });
}

function mimeFor(filePath) { const ext = path.extname(filePath).toLowerCase(); if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"; if (ext === ".png") return "image/png"; if (ext === ".mp4") return "video/mp4"; if (ext === ".lrf") return "video/mp4"; return "application/octet-stream"; }
function fileResponse(filePath, request) {
  const size = fs.statSync(filePath).size;
  const range = request.headers.get("range");
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match && match[1] ? Number(match[1]) : 0;
    let end = match && match[2] ? Number(match[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (!(start >= 0 && start < size && end >= start)) return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + size } });
    const stream = fs.createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream), { status: 206, headers: { "Content-Type": mimeFor(filePath), "Content-Length": String(end - start + 1), "Content-Range": "bytes " + start + "-" + end + "/" + size, "Accept-Ranges": "bytes" } });
  }
  return net.fetch(pathToFileURL(filePath).toString());
}

protocol.registerSchemesAsPrivileged([{ scheme: "dji-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
// In development, resources live beside the repository folder (cube&luts,
// watermark, and lut&log), so resolve from src/main back to the workspace root.
const developmentWorkspaceRoot = path.resolve(__dirname, "..", "..", "..");
const bundledWorkspaceRoot = process.resourcesPath;
const workspaceRoot = fs.existsSync(path.join(bundledWorkspaceRoot, "cube&luts")) ? bundledWorkspaceRoot : developmentWorkspaceRoot;
const bundledFfmpeg = path.join(bundledWorkspaceRoot, "bin", "ffmpeg.exe");
const bundledFfprobe = path.join(bundledWorkspaceRoot, "bin", "ffprobe.exe");
if (!process.env.FFMPEG_PATH && fs.existsSync(bundledFfmpeg)) process.env.FFMPEG_PATH = bundledFfmpeg;
if (!process.env.FFPROBE_PATH && fs.existsSync(bundledFfprobe)) process.env.FFPROBE_PATH = bundledFfprobe;
// Development fallback: a project-local bin/ lets a GPU-capable (libplacebo)
// ffmpeg be used without touching the machine's PATH. The portable build puts
// the same files in resources/bin, which the checks above already prefer.
const localBin = path.resolve(__dirname, "..", "..", "bin");
if (!process.env.FFMPEG_PATH && fs.existsSync(path.join(localBin, "ffmpeg.exe"))) process.env.FFMPEG_PATH = path.join(localBin, "ffmpeg.exe");
if (!process.env.FFPROBE_PATH && fs.existsSync(path.join(localBin, "ffprobe.exe"))) process.env.FFPROBE_PATH = path.join(localBin, "ffprobe.exe");
const catalog = new InMemoryMediaCatalog();
const localCatalog = new InMemoryMediaCatalog();
let settingsStore = null;
const previewResolver = new LrfPreviewSourceResolver();
const authorizedPreviewPaths = new Map();
const authorizedThumbnailPaths = new Map();
const authorizedPosterPaths = new Map();
const authorizedFallbackPaths = new Map();
const authorizedOriginalPaths = new Map();
// Badge artwork, so the picker can draw each watermark instead of asking the
// user to choose between names alone.
const authorizedWatermarkPaths = new Map();
const thumbnailLocator = new ThumbnailLocator();
const deviceProvider = new WindowsMassStorageDeviceProvider();
const pipeline = new MediaPipeline({ deviceProvider, mediaAccess: new ReadOnlyMediaAccess(), mediaProbe: new FfprobeMediaProbe(), catalog, workspaceRoot });
let colorRenderService = null; let watermarkRegistry = null; let previewStreamer = null; let mainWindow = null; let scanPromise = null; let localRefreshPromise = null; let localRefreshPending = false; let deviceSignature = null; let deviceWatcher = null;
const activeExports = new Set();
// Batch exports. Concurrency is 2: running two clips at once overlaps the gaps
// a serial queue leaves (the card read, the encoder hand-off, ffprobe
// validation) and measured ~1.1x. It is not a throughput fix -- a single 4K
// D-Log export only uses ~57% of this CPU and four at once only reach ~63%, so
// the limit is a shared serial stage (the one hardware-encoder engine), not
// idle cores. Raising it further buys nothing and costs memory, so 2 is the
// ceiling rather than 4.
let exportQueue = null;

// Batch items are named by their source file, so two clips called DJI_0001.MP4
// from different folders would otherwise overwrite each other. Windows paths
// compare case-insensitively.
function comparablePath(value) { return process.platform === "win32" ? path.resolve(String(value)).toLowerCase() : path.resolve(String(value)); }
function uniqueOutputPath(directory, fileName, used) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension) || "export";
  let candidate = path.join(directory, fileName);
  let counter = 1;
  // `used` covers the names this batch has already claimed, because two clips
  // can legitimately share one. The filesystem check covers everything already
  // in the folder, which matters more: the destination is where the user's other
  // exports live, and an export must never replace a file that is already there.
  // Measured before this check existed: a second batch run over the same clips
  // silently replaced the first run's output.
  while (used.has(comparablePath(candidate)) || fs.existsSync(candidate)) candidate = path.join(directory, stem + " (" + (++counter) + ")" + extension);
  used.add(comparablePath(candidate));
  return candidate;
}

// The items a batch will actually export, and how many requested ids were
// dropped because their source is unreadable. Shared by the setup sheet and the
// export itself so the list the user confirms is the list that runs.
//
// Photos are included. They used to be filtered out here, which made the list's
// "select all" a lie: it selected every row and then quietly exported only the
// videos. A still takes its own path through the pipeline, but it is still an
// export the user asked for.
function selectBatchAssets(assetIds) {
  const ids = Array.isArray(assetIds) ? assetIds.filter(id => typeof id === "string") : [];
  const requested = ids.map(getAssetAny).filter(Boolean);
  const assets = requested.filter(asset => asset.original && typeof asset.original.path === "string");
  return { assets, skipped: requested.length - assets.length };
}

// The colour answer for one clip in a batch. "auto" asks the shared detector; a
// specific transform is the user's explicit choice, which exists because
// detection can only read what the file carries -- a clip re-muxed or trimmed by
// another tool can lose the metadata that names its camera, and the export would
// then copy log footage without restoring it. Anything unrecognized falls back to
// detection rather than reaching the graph builder.
const BATCH_COLOR_MODES = new Set(["auto", "none", "action4", "action5pro", "action6", "pocket3", "pocket4", "pocket4p", "osmo-nano"]);
function resolveBatchColorMode(value) {
  const mode = String(value || "");
  return BATCH_COLOR_MODES.has(mode) ? mode : "auto";
}
function batchAutoEditor(asset, { colorMode = "auto", watermark = null } = {}) {
  const mode = resolveBatchColorMode(colorMode);
  return {
    technicalTransform: mode === "auto" ? technicalTransformFor(asset) : mode,
    creativeLook: "",
    watermark: watermark ? { ...watermark, enabled: true } : { enabled: false }
  };
}

// What the renderer is told about a badge. The path is kept in the main process
// and authorized for the media protocol, so the picker draws the mark from a URL
// without ever learning where the assets live.
function watermarkChoice(entry) {
  if (!entry) return null;
  authorizedWatermarkPaths.set(entry.id, entry.path);
  return { id: entry.id, family: entry.family, familyName: entry.familyName, variant: entry.variant, url: "dji-media://asset/watermark/" + encodeURIComponent(entry.id) };
}
// Every badge, grouped by device, for the picker's "all models" scope: detection
// can only read what a file carries, and a badge is a cosmetic choice, so a
// missing model must never be a dead end.
function watermarkCatalog() {
  if (!watermarkRegistry) return [];
  return watermarkRegistry.catalog().map(group => ({ family: group.family, name: group.name, entries: group.entries.map(watermarkChoice).filter(Boolean) }));
}

// The renderer is not trusted to name a watermark asset. Anything that is not
// an exact registered id, or not explicitly enabled, is dropped rather than
// passed into the graph builder.
function sanitizeBatchWatermark(value) {
  if (!value || typeof value !== "object" || value.enabled !== true) return null;
  const id = typeof value.id === "string" ? value.id : "";
  if (!id || !watermarkRegistry || !watermarkRegistry.get(id)) return null;
  const scale = Number(value.scale);
  const opacity = Number(value.opacity);
  return {
    id,
    scale: Number.isFinite(scale) ? Math.max(0.01, Math.min(1, scale)) : 0.195,
    opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1,
    position: { x: 0.5, y: 1 }
  };
}

function registerMediaProtocol() {
  protocol.handle("dji-media", async request => { try { const url = new URL(request.url); const parts = url.pathname.split("/").filter(Boolean); const assetId = parts.pop(); let map = authorizedPreviewPaths; if (parts[0] === "thumbnail") map = authorizedThumbnailPaths; else if (parts[0] === "poster") map = authorizedPosterPaths; else if (parts[0] === "fallback") map = authorizedFallbackPaths; else if (parts[0] === "original") map = authorizedOriginalPaths; else if (parts[0] === "watermark") map = authorizedWatermarkPaths; /* Only thumbnails are stored per size tier; every other route keys by id alone. */ const tier = parts[0] === "thumbnail" ? url.searchParams.get("w") : null; const key = assetId ? decodeURIComponent(assetId) + (tier ? "@" + tier : "") : null; const filePath = key ? map.get(key) || map.get(decodeURIComponent(assetId)) : null; if (!filePath) return new Response("Not found", { status: 404 }); return fileResponse(filePath, request); } catch { return new Response("Bad request", { status: 400 }); } });
}

async function scan() {
  if (scanPromise) return scanPromise;
  scanPromise = (async () => { const snapshot = await pipeline.scan({ onProgress: progress => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("media:scan-progress", progress); } }); authorizedPreviewPaths.clear(); authorizedThumbnailPaths.clear(); for (const asset of snapshot.assets) { const resolved = previewResolver.resolve(asset); if (resolved.status === "READY") authorizedPreviewPaths.set(asset.id, resolved.path); } if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("media:snapshot-updated", snapshot); return snapshot; })();
  try { return await scanPromise; } finally { scanPromise = null; }
}
function getAssetAny(assetId) { return findAssetInCatalogs(assetId, catalog, localCatalog); }
async function performLocalLibraryRefresh() {
  const roots = normalizePathList((settingsStore && settingsStore.get("localRoots")) || []);
  const selectedFiles = normalizePathList((settingsStore && settingsStore.get("localFiles")) || []).filter(filePath => !roots.some(root => isPathInside(filePath, root)));
  const probe = new FfprobeMediaProbe();
  const assets = [];
  const errors = [];
  if (settingsStore && settingsStore.lastLoadError) errors.push({ path: settingsStore.filePath, message: "Settings could not be read: " + settingsStore.lastLoadError.message });
  const appendUnique = found => { for (const item of found) if (!assets.some(existing => existing.id === item.id)) assets.push(item); };
  for (const root of roots) {
    const found = await scanLocalDirectory(root, { probe: filePath => probe.probe(filePath), onError: error => errors.push(error) });
    appendUnique(found);
  }
  const groups = await expandSelectedFiles(selectedFiles, { onError: error => errors.push(error) });
  for (const group of groups) {
    const found = await scanLocalDirectory(group.root, { maxDepth: 0, includeFile: filePath => group.allowedPaths.has(localPathKey(filePath)), probe: filePath => probe.probe(filePath), onError: error => errors.push(error) });
    appendUnique(found.filter(item => group.selectedOriginals.has(localPathKey(item.original.path))));
  }
  const snapshot = {
    devices: [],
    assets,
    files: assets.map(item => ({ name: item.original.name, extension: item.original.extension, size: item.original.size, path: item.original.path })),
    pairing: { highConfidence: 0, audioCandidates: 0 },
    status: "LOCAL_LIBRARY_SCANNED",
    scannedAt: new Date().toISOString(),
    errors
  };
  localCatalog.replace(snapshot);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("library:local-snapshot-updated", snapshot);
  return snapshot;
}
function refreshLocalLibrary() {
  localRefreshPending = true;
  if (!localRefreshPromise) {
    localRefreshPromise = (async () => {
      let snapshot = localCatalog.getSnapshot();
      do {
        localRefreshPending = false;
        snapshot = await performLocalLibraryRefresh();
      } while (localRefreshPending);
      return snapshot;
    })().finally(() => { localRefreshPromise = null; });
  }
  return localRefreshPromise;
}
function signatureFor(devices) { return JSON.stringify(devices.filter(device => device.status === "POSSIBLE_DJI_STORAGE").map(device => ({ id: device.id, status: device.status, cameraModel: device.cameraModel, evidence: device.evidence }))); }
function startDeviceWatcher() { const check = async () => { try { const devices = await deviceProvider.discover(); const nextSignature = signatureFor(devices); if (deviceSignature === null) { deviceSignature = nextSignature; return; } if (nextSignature !== deviceSignature) { deviceSignature = nextSignature; await scan(); } } catch (error) { console.error("Device watcher failed:", error); } }; check(); deviceWatcher = setInterval(check, 3000); }
function stopDeviceWatcher() { if (deviceWatcher) clearInterval(deviceWatcher); deviceWatcher = null; }
function createWindow() { const window = new BrowserWindow({ width: 1440, height: 920, minWidth: 1024, minHeight: 680, webPreferences: { preload: path.join(__dirname, "..", "preload", "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } }); mainWindow = window; window.setMenuBarVisibility(false); window.loadFile(path.join(__dirname, "..", "renderer", "index.html")); window.on("closed", () => { if (previewStreamer) previewStreamer.shutdownNow(); shutdownFallbackProxies(); if (mainWindow === window) mainWindow = null; }); }
const colorPresets = new Map([["normal", null], ["action4-dlogm", null], ["action4-forest-pro", "action4.creative.forest-pro"], ["action4-ice-pro", "action4.creative.ice-pro"], ["action4-nature-pro", "action4.creative.nature-pro"]]);
async function graphForEditor(editor = {}) {
  const graph = createEditorEffectGraph(editor);
  const transform = editor.displayTransform || {};
  const overlay = editor.watermark && watermarkRegistry && watermarkRegistry.get(editor.watermark.id);
  const active = overlay && editor.watermark.enabled;
  // Each badge PNG pads its glyphs differently, so the visible ink box must be
  // measured from the asset itself. Without it the graph falls back to the
  // borderless box, which is out of bounds for every other asset and makes
  // ffmpeg abort with -22 rather than just placing the mark badly. Measurement
  // is cached by content hash, so this awaits real work only once per asset.
  let inkBox = null;
  if (active) {
    try { inkBox = await watermarkRegistry.ensureInkBox(overlay.id); }
    catch (error) { console.error("Watermark ink box measurement failed:", error); }
  }
  return createEffectGraph({ ...graph, displayGeometry: { ...graph.displayGeometry, ...(transform || {}) }, overlays: active ? [{ kind: "image", path: overlay.path, resourceId: overlay.id, sha256: overlay.sha256, inkBox: inkBox || null, canvasSize: inkBox && inkBox.canvas ? inkBox.canvas : null, position: editor.watermark.position, scale: editor.watermark.scale, opacity: editor.watermark.opacity, rotation: editor.watermark.rotation, enabled: true }] : [] });
}
// Confirm the finished file before the atomic rename puts it in place.
//
// Parsing happens inside a try: a successful ffprobe that prints something
// unexpected used to throw out of the close handler, and an exception there is
// uncaught in the main process -- the whole app died because one export
// returned odd JSON. A deadline matters for the same reason as the probe: ffmpeg
// can leave a file ffprobe will wait on forever.
const VALIDATE_TIMEOUT_MS = 20000;
function validateExport(outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "format=size,duration:stream=codec_type,codec_name,width,height,avg_frame_rate", "-of", "json", outputPath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    let settled = false;
    let timer = null;
    const finish = (error, value) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); if (error) reject(error); else resolve(value); };
    timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(new Error("Export validation timed out after " + (VALIDATE_TIMEOUT_MS / 1000) + "s: " + outputPath)); }, VALIDATE_TIMEOUT_MS);
    child.stdout.on("data", chunk => out.push(chunk));
    child.stderr.on("data", chunk => err.push(chunk));
    child.on("error", error => finish(error));
    child.on("close", code => {
      if (code !== 0) { finish(new Error(Buffer.concat(err).toString() || ("ffprobe exited with code " + code))); return; }
      try { finish(null, { exists: true, ...JSON.parse(Buffer.concat(out).toString()) }); }
      catch (error) { finish(new Error("Export validation returned unreadable output: " + error.message)); }
    });
  });
}
// Batch exports run several of these against the same destination directory.
// pid+Date.now() is millisecond resolution, so two exports starting in the same
// tick produced the SAME temporary name: one export would then rename the
// other's half-written file into place, or delete it on failure. A monotonic
// counter makes the name unique regardless of timing.
let exportSequence = 0;
async function exportAtomically(inputPath, outputPath, graph, clip, onProgress, signal = null, videoSpec = null) {
  // Validate the final path before creating a temporary export. Checking only
  // the temporary path lets Export As target the source and later delete it.
  assertSafeExportTarget(inputPath, outputPath);
  const temporaryPath = path.join(path.dirname(outputPath), ".dji-export-" + process.pid + "-" + (++exportSequence) + "-" + Date.now() + ".mp4");
  try {
    const exported = await colorRenderService.exportOriginal(inputPath, temporaryPath, graph, null, null, clip, onProgress, signal, { videoSpec });
    const validation = await validateExport(temporaryPath);
    await fs.promises.rm(outputPath, { force: true });
    await fs.promises.rename(temporaryPath, outputPath);
    // Explorer's date column is the file's modification time, so without this a
    // finished export looks like it was shot today and sorts away from the
    // original. The camera's own EXIF/name carries the real capture time.
    stampCaptureTime(outputPath, captureTimeFor(inputPath, path.basename(outputPath)));
    return { ...exported, outputPath, validation };
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

// A still export reuses the one implementation the unattended card script uses,
// so a batch run here and a script run there produce the same bytes. A still is
// single-frame work, so it goes straight from "running" to "done".
async function exportJpegAsset(asset, outputPath, watermark, onProgress, signal) {
  if (typeof onProgress === "function") onProgress(0);
  const result = await exportJpeg({
    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
    inputPath: asset.original.path,
    outputPath,
    watermarkPath: watermark ? watermark.path : null,
    inkBox: watermark ? watermark.inkBox : null,
    signal
  });
  return { outputPath, validation: null, bytes: result.bytes, encoder: watermark ? "mjpeg-overlay" : "jpeg-copy" };
}

if (singleInstanceLock) app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

if (singleInstanceLock) app.whenReady().then(() => {
  settingsStore = new ConfigStore({ filePath: path.join(app.getPath("userData"), "config.json"), defaults: { language: "en", exportLocation: app.getPath("videos"), localRoots: [], localFiles: [] } });
  refreshLocalLibrary();
  watermarkRegistry = createWatermarkRegistry(workspaceRoot, { cacheRoot: path.join(app.getPath("userData"), "watermark-ink") });
  const previewLutRegistry = createOfficialLutRegistry(workspaceRoot);
  const generatedCacheRoot = path.join(app.getPath("userData"), "generated-luts");
  colorRenderService = new ColorRenderService({ root: workspaceRoot, lutRegistry: previewLutRegistry, styleRegistry: null, cacheRoot: generatedCacheRoot });
  exportQueue = new ExportQueue({
    concurrency: 2,
    onUpdate: items => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("export:batch-update", items); }
  });
  previewStreamer = new PreviewFrameStreamer({ lutRegistry: previewLutRegistry, styleRegistry: null, cacheRoot: generatedCacheRoot, width: 640, height: 360 });
  registerMediaProtocol();
  ipcMain.handle("media:scan", async () => scan()); ipcMain.handle("media:snapshot", () => catalog.getSnapshot());
  ipcMain.handle("library:local-snapshot", () => localCatalog.getSnapshot());
  ipcMain.handle("library:add-folder", async () => { const picked = await dialog.showOpenDialog({ properties: ["openDirectory"] }); if (picked.canceled || !picked.filePaths.length) return localCatalog.getSnapshot(); settingsStore.set("localRoots", addSource(settingsStore.get("localRoots"), picked.filePaths[0])); return refreshLocalLibrary(); });
  ipcMain.handle("library:import-files", async () => { const picked = await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"], filters: [{ name: "Media", extensions: ["mp4", "mov", "m4v", "mkv", "jpg", "jpeg", "png"] }] }); if (picked.canceled || !picked.filePaths.length) return localCatalog.getSnapshot(); settingsStore.set("localFiles", normalizePathList([...(settingsStore.get("localFiles") || []), ...picked.filePaths])); return refreshLocalLibrary(); });
  ipcMain.handle("library:refresh", () => refreshLocalLibrary());
  ipcMain.handle("library:sources", () => sourceSnapshot(settingsStore.data));
  ipcMain.handle("library:remove-source", async (_event, source = {}) => { const key = source.kind === "folder" ? "localRoots" : source.kind === "file" ? "localFiles" : null; if (!key || typeof source.path !== "string") throw new Error("Invalid local source"); settingsStore.set(key, removeSource(settingsStore.get(key), source.path)); const snapshot = await refreshLocalLibrary(); return { snapshot, sources: sourceSnapshot(settingsStore.data) }; });
  ipcMain.handle("settings:get", () => settingsStore.data);
  ipcMain.handle("settings:set", (_event, patch) => { patch = patch || {}; for (const key of ["language", "exportLocation"]) if (patch[key] !== undefined) settingsStore.set(key, patch[key]); return settingsStore.data; });
  ipcMain.handle("settings:choose-export-location", async () => { const picked = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] }); if (picked.canceled || !picked.filePaths.length) return settingsStore.get("exportLocation") || ""; settingsStore.set("exportLocation", picked.filePaths[0]); return picked.filePaths[0]; });
  ipcMain.handle("media:preview-url", async (_event, assetId) => { if (typeof assetId !== "string") return null; const asset = getAssetAny(assetId); if (!asset) return null; if (asset.mediaKind === "photo") { authorizedOriginalPaths.set(assetId, asset.original.path); return { url: "dji-media://asset/original/" + encodeURIComponent(assetId), sourceType: "PHOTO" }; } const resolved = previewResolver.resolve(asset); if (resolved.status === "READY") { authorizedPreviewPaths.set(assetId, resolved.path); return { url: "dji-media://asset/" + encodeURIComponent(assetId), sourceType: "LRF_PROXY" }; } authorizedOriginalPaths.set(assetId, asset.original.path); return { url: "dji-media://asset/original/" + encodeURIComponent(assetId), sourceType: "ORIGINAL" }; });
  ipcMain.handle("media:preview-fallback", async (_event, assetId) => { if (typeof assetId !== "string") return null; const asset = getAssetAny(assetId); if (!asset) return null; const durationSeconds = Number(asset.original && asset.original.probe && asset.original.probe.duration) || 0; const sendProgress = pct => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("media:preview-progress", { assetId, pct }); }; try { const proxy = await ensureFallbackProxy({ assetId, originalPath: asset.original.path, cacheRoot: path.join(app.getPath("userData"), "cache", "fallbacks"), durationSeconds, onProgress: pct => { sendProgress(pct); } }); if (proxy) { authorizedFallbackPaths.set(assetId, proxy); sendProgress(100); return { url: "dji-media://asset/fallback/" + encodeURIComponent(assetId), sourceType: "ORIGINAL_FALLBACK" }; } } catch (error) { console.error("Fallback failed:", error); } return null; });
  // minWidth lets the caller state how large the tile it will draw is. The
  // camera writes a 160x90 THM beside a 1280x720 SCR, so the same clip needs the
  // small file for a dense list and the large one for the poster grid; serving
  // the THM in both cases is what made the poster tiles soft. A plain string is
  // still accepted so existing callers keep working.
  ipcMain.handle("media:thumbnail-url", async (_event, request) => {
    const assetId = typeof request === "string" ? request : request && request.assetId;
    const minWidth = typeof request === "object" && request ? Number(request.minWidth) || 0 : 0;
    if (typeof assetId !== "string") return null;
    const asset = getAssetAny(assetId); if (!asset) return null;
    const resolved = previewResolver.resolve(asset);
    try {
      const found = thumbnailLocator.locate(asset);
      const cacheRoot = path.join(app.getPath("userData"), "cache", "thumbnails");
      const cacheHit = fs.existsSync(resolveCachePath({ assetId, thmPath: found.thm, scrPath: found.scr, originalPath: asset.original.path, cacheRoot, minWidth }));
      const thumbnail = await ensureThumbnail({ assetId, previewPath: resolved.status === "READY" ? resolved.path : null, originalPath: asset.original.path, thmPath: found.thm, scrPath: found.scr, cacheRoot, minWidth });
      if (thumbnail) {
        // The size tier is part of both the authorization key and the URL. The
        // file behind the URL changes with the tier, and Chromium caches by URL
        // alone, so a shared URL would keep serving the tier it fetched first.
        const key = assetId + "@" + minWidth;
        authorizedThumbnailPaths.set(key, thumbnail);
        return { url: "dji-media://asset/thumbnail/" + encodeURIComponent(assetId) + "?w=" + minWidth, cacheHit };
      }
    } catch (error) { console.error("Thumbnail failed:", error); }
    return null;
  });
  ipcMain.handle("media:poster-url", async (_event, assetId) => { if (typeof assetId !== "string") return null; const asset = getAssetAny(assetId); if (!asset) return null; const resolved = previewResolver.resolve(asset); try { const found = thumbnailLocator.locate(asset); const posterRoot = path.join(app.getPath("userData"), "cache", "posters"); const poster = await ensurePoster({ assetId, previewPath: resolved.status === "READY" ? resolved.path : null, originalPath: asset.original.path, scrPath: found.scr, posterRoot }); if (poster) { authorizedPosterPaths.set(assetId, poster); return "dji-media://asset/poster/" + encodeURIComponent(assetId); } } catch (error) { console.error("Poster failed:", error); } return null; });
  ipcMain.handle("editor:open", (_event, assetId) => { const asset = getAssetAny(assetId); if (!asset) throw new Error("Asset unavailable"); const matched = watermarkRegistry ? watermarkRegistry.forCameraModel(asset.cameraModel) : []; const fallback = watermarkChoice(watermarkRegistry && watermarkRegistry.get("action4.official.oa4")); /* An unidentified model still gets the whole set of the default device -- one lone badge would hide the rest of the family. */ const own = matched.length ? matched : (watermarkRegistry ? watermarkRegistry.forCameraModel("DJI Osmo Action 4") : []); const watermarks = own.map(watermarkChoice).filter(Boolean); return { asset, clip: createTimelineClip(asset), colorMode: "UNKNOWN", looks: [...colorPresets.keys()], watermark: watermarks[0] || fallback, watermarks: watermarks.length ? watermarks : (fallback ? [fallback] : []), watermarkCatalog: watermarkCatalog() }; });
  ipcMain.handle("editor:preview-frame", async (_event, args = {}) => { const asset = getAssetAny(args.assetId); if (!asset) throw new Error("Asset unavailable"); const resolved = previewResolver.resolve(asset); let sourcePath = resolved.status === "READY" ? resolved.path : null; if (!sourcePath) sourcePath = asset.original && asset.original.path ? asset.original.path : null; if (!sourcePath) sourcePath = await ensureFallbackProxy({ assetId: asset.id, originalPath: asset.original.path, cacheRoot: path.join(app.getPath("userData"), "cache", "fallbacks") }); if (!sourcePath) throw new Error("Edit preview requires an LRF companion or a decodable original"); const graph = await graphForEditor(args.editor); const seconds = Number(args.timelineSeconds || 0) * Number(args.editor?.clip?.playbackRate || 1) + Number(args.editor?.clip?.sourceInUs || 0) / 1000000; return colorRenderService.renderPreviewFrame(sourcePath, seconds, graph, 1280, 720); });
  function sourceFrameRate(asset, sourcePath) {
    const previewPath = asset && asset.preview && asset.preview !== "UNKNOWN" && asset.preview.path;
    const usesPreview = !!(previewPath && sourcePath && path.resolve(previewPath) === path.resolve(sourcePath));
    const candidates = usesPreview ? [asset.preview && asset.preview.probe, asset.original && asset.original.probe] : [asset.original && asset.original.probe, asset.preview && asset.preview.probe];
    for (const probe of candidates) {
      const fps = probe && probe.fps;
      const value = fps && typeof fps.value === "number" && fps.value > 0 ? fps.value : (typeof fps === "number" && fps > 0 ? fps : null);
      if (value) return Math.min(120, Math.max(15, value));
    }
    return 30;
  }
  async function resolveEditSource(assetId, webContents) { const asset = getAssetAny(assetId); if (!asset) throw new Error("Asset unavailable"); const resolved = previewResolver.resolve(asset); let sourcePath = resolved.status === "READY" ? resolved.path : null; if (!sourcePath) { if (isDirectEditCodec(asset)) sourcePath = asset.original.path; else { const durationSeconds = Number(asset.original && asset.original.probe && asset.original.probe.duration) || 0; const sendProgress = pct => { if (webContents && !webContents.isDestroyed?.()) webContents.send("media:preview-progress", { assetId: asset.id, pct }); }; sourcePath = await ensureFallbackProxy({ assetId: asset.id, originalPath: asset.original.path, cacheRoot: path.join(app.getPath("userData"), "cache", "fallbacks"), durationSeconds, onProgress: sendProgress }); } } if (!sourcePath) throw new Error("Edit preview requires an LRF companion or a decodable original"); return { asset, sourcePath }; }
  ipcMain.handle("editor:preview-start", async (_event, args = {}) => { const { asset, sourcePath } = await resolveEditSource(args.assetId, _event.sender); const graph = await graphForEditor(args.editor); return previewStreamer.start({ assetId: args.assetId, sourcePath, editor: args.editor, graph, webContents: _event.sender, timelineSeconds: args.timelineSeconds, frameRate: sourceFrameRate(asset, sourcePath) }); });
  ipcMain.handle("editor:preview-update", async (_event, args = {}) => { const graph = await graphForEditor(args.editor); return previewStreamer.update(args.assetId, { editor: args.editor, graph, timelineSeconds: args.timelineSeconds }); });
  ipcMain.handle("editor:preview-seek", async (_event, args = {}) => previewStreamer.seek(args.assetId, args.timelineSeconds));
  ipcMain.on("editor:preview-clock", (_event, args = {}) => { if (previewStreamer) previewStreamer.reportClock(args.assetId, args.clockSourceTime); });
ipcMain.handle("editor:preview-pause", (_event, args = {}) => previewStreamer.pause(args.assetId));
  ipcMain.handle("editor:preview-resume", async (_event, args = {}) => previewStreamer.resume(args.assetId, args.timelineSeconds));
  ipcMain.handle("editor:preview-stop", async (_event, args = {}) => { cancelFallbackProxy(args.assetId); return previewStreamer.stop(args.assetId); });
  async function runExportIpc(event, args, choosePath) { const asset = getAssetAny(args.assetId); if (!asset) throw new Error("Asset unavailable"); const outputPath = await choosePath(asset); if (!outputPath) return { canceled: true }; const controller = new AbortController(); activeExports.add(controller); if (!event.sender.isDestroyed()) event.sender.send("export:progress", { assetId: asset.id, destination: outputPath }); const onProgress = pct => { if (!event.sender.isDestroyed()) event.sender.send("export:progress", { assetId: asset.id, pct }); }; try { return await exportAtomically(asset.original.path, outputPath, await graphForEditor(args.editor), args.editor.clip, onProgress, controller.signal); } finally { activeExports.delete(controller); } }
  ipcMain.handle("editor:export", (_event, args = {}) => runExportIpc(_event, args, asset => { const exportDir = settingsStore.get("exportLocation") || app.getPath("videos"); return colorRenderService.defaultExportPath(asset.original.name, "phase4", exportDir); }));
  ipcMain.handle("editor:export-as", (_event, args = {}) => runExportIpc(_event, args, async asset => { const picked = await dialog.showSaveDialog({ defaultPath: path.join(settingsStore.get("exportLocation") || app.getPath("videos"), path.basename(asset.original.name, path.extname(asset.original.name)) + ".phase4.mp4"), filters: [{ name: "MP4", extensions: ["mp4"] }] }); return picked.canceled || !picked.filePath ? null : picked.filePath; }));
  ipcMain.handle("editor:export-cancel", () => { for (const controller of activeExports) controller.abort(); return { canceled: activeExports.size > 0 }; });
  // Fills the batch setup sheet before anything is queued. Detection happens
  // here rather than in the renderer so the clips the sheet calls D-Log are
  // exactly the clips export will restore; the renderer never gets a second,
  // possibly divergent, opinion.
  ipcMain.handle("library:batch-setup", async (_event, args = {}) => {
    const { assets, skipped } = selectBatchAssets(args.assetIds);
    const destination = settingsStore.get("exportLocation") || app.getPath("videos");
    const watermarks = (watermarkRegistry ? watermarkRegistry.forCameraModels(assets.map(asset => asset.cameraModel)) : []).map(watermarkChoice).filter(Boolean);
    // A selection whose cameras this build does not know still offers the
    // default badge, and the picker can browse every other device from there.
    if (!watermarks.length) { /* Unidentified footage gets the default device's whole set, not one badge. */ for (const entry of (watermarkRegistry ? watermarkRegistry.forCameraModel("DJI Osmo Action 4") : [])) { const choice = watermarkChoice(entry); if (choice) watermarks.push(choice); } const fallback = watermarkChoice(watermarkRegistry && watermarkRegistry.get("action4.official.oa4")); if (!watermarks.length && fallback) watermarks.push(fallback); }
    return {
      destination,
      skipped,
      watermarks,
      watermarkCatalog: watermarkCatalog(),
      clips: assets.map(asset => ({
        assetId: asset.id,
        name: asset.original.name,
        kind: asset.mediaKind === "photo" ? "photo" : "video",
        // A still has no colour pipeline to restore, so only clips can carry the
        // restoration tag.
        needsRestore: asset.mediaKind !== "photo" && technicalTransformFor(asset) !== "none"
      }))
    };
  });
  // Batch export. Every selected clip is queued into the configured export
  // location.
  //
  // Deliberately no folder dialog: the single-item export already writes to the
  // configured location without asking, and prompting once per batch would be
  // exactly the friction batch export exists to remove. The location stays
  // changeable from Settings, and the dialog reports where the files landed.
  //
  // Restoration is per clip: a D-Log clip gets its own camera's Rec.709
  // transform and takes the transcode path, while a Standard clip stays on the
  // neutral graph and keeps the cable-speed copy path. Watermarking, when
  // enabled, forces every clip through a transcode because it alters pixels.
  ipcMain.handle("library:export-batch", async (event, args = {}) => {
    if (!exportQueue) throw new Error("Export queue is not ready");
    const { assets, skipped } = selectBatchAssets(args.assetIds);
    if (!assets.length) return { canceled: false, batchId: null, queued: 0, skipped, destination: "" };
    const destination = settingsStore.get("exportLocation") || app.getPath("videos");
    const colorMode = resolveBatchColorMode(args.colorMode);
    const watermark = sanitizeBatchWatermark(args.watermark);
    // Video specification (resolution / frame rate / bitrate / 10-bit) applies
    // to every clip in the batch. Still images ignore it; a JPEG has no frame
    // rate or bit depth to choose.
    const videoSpec = normalizeVideoSpec(args.videoSpec);

    // Photos and stream-copy targets still need a unique name each, and a clip
    // must never be exported on top of its own source.
    const used = new Set(assets.map(asset => comparablePath(asset.original.path)));
    const batchId = "batch-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const queued = [];
    // The watermark's ink box is measured once for the whole batch: it is cached
    // by content hash, and a photo and a clip must land the badge on the same
    // visual line.
    let badge = null;
    let inkBox = null;
    if (watermark) {
      badge = watermarkRegistry.get(watermark.id);
      if (badge) inkBox = await watermarkRegistry.ensureInkBox(badge.id);
    }
    for (const asset of assets) {
      const outputPath = uniqueOutputPath(destination, asset.original.name, used);
      const itemId = batchId + ":" + asset.id;
      // A still takes its own path: one overlay, one JPEG encode, or a plain copy
      // when no watermark was asked for.
      if (asset.mediaKind === "photo") {
        queued.push({ itemId, assetId: asset.id, name: asset.original.name, outputPath, kind: "photo" });
        exportQueue.add({
          id: itemId,
          batchId,
          assetId: asset.id,
          label: asset.original.name,
          destination: outputPath,
          run: ({ signal, onProgress }) => exportJpegAsset(asset, outputPath, badge && inkBox ? { path: badge.path, inkBox } : null, onProgress, signal)
        });
        continue;
      }
      // Graphs are built per asset because the transform differs by camera.
      // Building one is cheap and does no I/O until the watermark ink box has to
      // be measured, which is cached by content hash across the batch.
      const graph = await graphForEditor(batchAutoEditor(asset, { colorMode, watermark }));
      queued.push({ itemId, assetId: asset.id, name: asset.original.name, outputPath, kind: "video" });
      exportQueue.add({
        id: itemId,
        batchId,
        assetId: asset.id,
        label: asset.original.name,
        destination: outputPath,
        run: ({ signal, onProgress }) => exportAtomically(asset.original.path, outputPath, graph, null, pct => onProgress(pct), signal, videoSpec)
      });
    }
    return { canceled: false, batchId, queued: queued.length, skipped, destination, items: queued };
  });
  // Cancel one batch item, or a whole batch when only batchId is supplied.
  ipcMain.handle("library:export-batch-cancel", (_event, args = {}) => {
    if (!exportQueue) return { canceled: 0 };
    if (typeof args.itemId === "string" && args.itemId) return { canceled: exportQueue.cancel(args.itemId) ? 1 : 0 };
    if (typeof args.batchId === "string" && args.batchId) return { canceled: exportQueue.cancelBatch(args.batchId) };
    return { canceled: exportQueue.cancelAll() };
  });
  // Reveal only an existing absolute file. showItemInFolder is a shell call, so
  // a relative or missing path must not reach it from the renderer.
  ipcMain.handle("shell:reveal-path", async (_event, target) => { const text = String(target || ""); if (!text || !path.isAbsolute(text)) return { revealed: false }; try { const stat = await fs.promises.stat(text); if (!stat.isFile()) return { revealed: false }; } catch { return { revealed: false }; } shell.showItemInFolder(text); return { revealed: true }; });
  createWindow(); startDeviceWatcher(); app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("before-quit", () => { stopDeviceWatcher(); for (const controller of activeExports) controller.abort(); if (previewStreamer) previewStreamer.shutdownNow(); shutdownFallbackProxies(); }); app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
process.once("exit", () => { if (previewStreamer) previewStreamer.shutdownNow(); shutdownFallbackProxies(); });
