const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { ReadOnlyMediaAccess } = require("../src/media-access/read-only-media-access");
const { FfprobeMediaProbe } = require("../src/media-probe/ffprobe-media-probe");
const { WindowsMassStorageDeviceProvider, identifyDjiDevice } = require("../src/device-adapter/windows-mass-storage-device-provider");
const { InMemoryMediaCatalog } = require("../src/catalog/in-memory-media-catalog");
const { MediaPipeline, geometry, mapWithConcurrency } = require("../src/media-pipeline");
const { ScoredPairingEngine } = require("../src/pairing/scored-pairing-engine");
const { LrfPreviewSourceResolver } = require("../src/preview/lrf-preview-source-resolver");
const { UNKNOWN } = require("../src/shared/models");
const workspaceRoot = path.resolve(__dirname, "..", "..");
const fixtureRoot = path.join(workspaceRoot, "dji-test-media");
async function makePipeline() { return new MediaPipeline({ deviceProvider: { discover: async () => [] }, mediaAccess: new ReadOnlyMediaAccess(), mediaProbe: new FfprobeMediaProbe(), catalog: new InMemoryMediaCatalog(), workspaceRoot }); }
function runCommand(command, args) { return new Promise((resolve, reject) => { const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }); let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk.toString(); }); child.on("error", reject); child.on("close", code => resolve({ code, stderr })); }); }

test("offline pipeline identifies all eight real media fixtures", async () => { const snapshot = await (await makePipeline()).scan(); assert.equal(snapshot.files.length, 8); assert.equal(snapshot.files.filter(file => file.extension === "mp4").length, 4); assert.equal(snapshot.files.filter(file => file.extension === "lrf").length, 2); assert.equal(snapshot.files.filter(file => file.extension === "aac").length, 2); assert.equal(snapshot.assets.length, 4); assert.equal(snapshot.pairing.highConfidence, 2); assert.equal(snapshot.pairing.audioCandidates, 2); assert.equal(snapshot.status, "NO_DJI_CAMERA_DETECTED_OFFLINE_MEDIA_SCANNED"); });

test("MP4/LRF evidence is high confidence but not confirmed", async () => { const access = new ReadOnlyMediaAccess(); const probe = new FfprobeMediaProbe(); const files = await access.listMediaFiles(fixtureRoot); const records = await Promise.all(files.map(async file => ({ path: file, id: path.basename(file), probe: await probe.probe(file), lastWriteTime: (await fs.stat(file)).mtime.toISOString() }))); const pairing = new ScoredPairingEngine().pair(records.filter(file => file.path.toLowerCase().endsWith(".mp4")), records.filter(file => file.path.toLowerCase().endsWith(".lrf")), records.filter(file => file.path.toLowerCase().endsWith(".aac"))); assert.equal(pairing.pairs.length, 2); assert.ok(pairing.pairs.every(pair => pair.evidence.status === "HIGH_CONFIDENCE")); assert.ok(pairing.pairs.every(pair => pair.evidence.status !== "CONFIRMED")); assert.ok(pairing.audioCandidates.every(candidate => candidate.syncStatus === "UNKNOWN")); });

test("ffprobe normalization preserves unknown fields and DJI facts", async () => { const probe = new FfprobeMediaProbe(); const normal = await probe.probe(path.join(fixtureRoot, "普通色彩.MP4")); assert.equal(normal.codec, "hevc"); assert.equal(normal.profile, "Main 10"); assert.equal(normal.width, 3840); assert.equal(normal.height, 2160); assert.equal(normal.audio.codec, "aac"); assert.equal(normal.timecode, "17:11:13;20"); assert.equal(normal.metadata.encoder, "DJI OsmoAction4"); const silent = await probe.probe(path.join(fixtureRoot, "高帧率.MP4")); assert.equal(silent.audio.codec, UNKNOWN); assert.equal(silent.sampleRate, UNKNOWN); assert.equal(silent.channels, UNKNOWN); });

test("geometry keeps original rotation separate from preview geometry", async () => { const probe = new FfprobeMediaProbe(); const original = geometry(await probe.probe(path.join(fixtureRoot, "竖屏高帧率视频.MP4"))); const preview = geometry(await probe.probe(path.join(fixtureRoot, "普通色彩.LRF"))); assert.equal(original.rotation, -90); assert.equal(original.encodedWidth, 3840); assert.equal(original.encodedHeight, 2160); assert.equal(original.displayWidth, 2160); assert.equal(original.displayHeight, 3840); assert.equal(preview.rotation, UNKNOWN); assert.equal(preview.displayWidth, 1280); assert.equal(preview.displayHeight, 720); });

test("LRF samples seek and decode at 500 milliseconds", async () => { for (const name of ["普通色彩.LRF", "d log 10bit.LRF"]) { const result = await runCommand(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-ss", "0.5", "-i", path.join(fixtureRoot, name), "-frames:v", "1", "-f", "null", "-"]); assert.equal(result.code, 0, result.stderr); } });

test("preview resolver returns LRF and no fallback proxy", async () => { const snapshot = await (await makePipeline()).scan(); const resolver = new LrfPreviewSourceResolver(); assert.equal(resolver.resolve(snapshot.assets.find(asset => asset.original.name === "普通色彩.MP4")).status, "READY"); assert.equal(resolver.resolve({ preview: UNKNOWN }).status, "PREVIEW_UNAVAILABLE"); });

test("scan does not modify fixture files and remains bounded", async () => { const before = new Map(); for (const file of await new ReadOnlyMediaAccess().listMediaFiles(fixtureRoot)) { const stat = await fs.stat(file); before.set(file, stat.mtimeMs + ":" + stat.size); } const scan = (await makePipeline()).scan(); let timer; const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("pipeline blocked")), 60000); }); try { await Promise.race([scan, timeout]); } finally { clearTimeout(timer); } for (const [file, signature] of before) { const stat = await fs.stat(file); assert.equal(stat.mtimeMs + ":" + stat.size, signature, file); } });

test("Windows device provider does not claim devices off Windows", async () => { const provider = new WindowsMassStorageDeviceProvider({ platform: "linux" }); assert.deepEqual(await provider.discover(), []); });

test("camera identity accepts Windows friendly name and DJI VID/PID", () => { const named = identifyDjiDevice([{ Name: "OsmoAction4", PNPDeviceID: "USB\\VID_2CA3&PID_0020" }]); assert.equal(named.cameraName, "OsmoAction4"); assert.equal(named.source, "Windows PnP friendly name"); const vidOnly = identifyDjiDevice([{ Name: "USB Mass Storage Device", PNPDeviceID: "USB\\VID_2CA3&PID_0020&MI_02" }]); assert.equal(vidOnly.hasDjiUsb, true); assert.equal(vidOnly.cameraName, "UNKNOWN"); });

test("bounded probe workers preserve order and concurrency", async () => {
  let active = 0;
  let peak = 0;
  const values = await mapWithConcurrency([0, 1, 2, 3, 4, 5], 3, async value => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return value * 2;
  });
  assert.deepEqual(values, [0, 2, 4, 6, 8, 10]);
  assert.equal(peak, 3);
});

test("probe worker count has a hard upper bound", async () => {
  let active = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 20 }), 100, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
  });
  assert.equal(peak, 8);
});

test("concurrent camera scan keeps errors in discovery order", async () => {
  const files = ["X:\\DCIM\\0.aac", "X:\\DCIM\\1.aac", "X:\\DCIM\\2.aac"];
  const pipeline = new MediaPipeline({
    deviceProvider: { discover: async () => [{ id: "test", path: "X:\\", status: "POSSIBLE_DJI_STORAGE" }] },
    mediaAccess: { listMediaFiles: async () => files, stat: async () => ({ size: 1, mtime: new Date(0), mtimeMs: 0 }) },
    mediaProbe: { probe: async file => { await new Promise(resolve => setTimeout(resolve, file.endsWith("0.aac") ? 20 : 1)); throw new Error("failed"); } },
    catalog: new InMemoryMediaCatalog(),
    workspaceRoot,
    colorModeDetector: async () => ({ mode: "UNKNOWN" })
  });
  const progress = [];
  const snapshot = await pipeline.scan({ onProgress: event => progress.push(event) });
  assert.deepEqual(snapshot.errors.map(error => error.path), files);
  const scanning = progress.filter(event => event.stage === "SCANNING_MEDIA");
  assert.deepEqual(scanning.map(event => event.completed), [0, 1, 2, 3]);
  assert.ok(scanning.every(event => event.total === files.length));
});
