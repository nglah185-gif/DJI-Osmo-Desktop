const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { ReadOnlyMediaAccess } = require("../src/media-access/read-only-media-access");
const { FfprobeMediaProbe } = require("../src/media-probe/ffprobe-media-probe");
const { InMemoryMediaCatalog } = require("../src/catalog/in-memory-media-catalog");
const { MediaPipeline } = require("../src/media-pipeline");
const workspaceRoot = path.resolve(__dirname, "..", "..");

function makePipeline(discover) { return new MediaPipeline({ deviceProvider: { discover }, mediaAccess: new ReadOnlyMediaAccess(), mediaProbe: new FfprobeMediaProbe(), catalog: new InMemoryMediaCatalog(), workspaceRoot }); }

test("MP4 + LRF + AAC aggregate into a single MediaAsset", async () => {
  const snapshot = await makePipeline(async () => []).scan();
  const lrfNames = snapshot.files.filter(file => file.extension === "lrf").map(file => file.name);
  const assets = snapshot.assets;
  assert.equal(assets.length, 4);
  assert.ok(assets.every(asset => asset.original && asset.original.extension === "mp4"));
  assert.equal(assets.some(asset => asset.original && asset.original.extension === "lrf"), false, "LRF must not appear as an asset original");
  const paired = assets.filter(asset => asset.preview !== "UNKNOWN");
  assert.equal(paired.length, 2, "two high-confidence LRF pairs");
  assert.ok(paired.every(asset => asset.preview.extension === "lrf"));
  assert.equal(snapshot.pairing.unmatchedPreviews, 0);
  assert.ok(snapshot.assets.some(asset => asset.externalAudioCandidates.length > 0), "AAC candidate attaches to an asset, not the library");
});

test("no-LRF clip with companion AAC is classified SLOW_MOTION", async () => {
  const snapshot = await makePipeline(async () => []).scan();
  const slow = snapshot.assets.find(asset => asset.original.name.startsWith("高帧率"));
  assert.ok(slow, "fixture 高帧率.MP4 exists");
  assert.equal(slow.preview, "UNKNOWN", "slow-mo clip has no LRF");
  assert.equal(slow.externalAudioCandidates.length, 1, "slow-mo clip has companion AAC");
  assert.equal(slow.captureMode, "SLOW_MOTION");
  assert.equal(slow.captureModeEvidence.reason, "no-lrf-with-aac");
  const standard = snapshot.assets.find(asset => asset.original.name.startsWith("普通色彩"));
  assert.equal(standard.captureMode, "STANDARD");
});

test("device present suppresses offline sample root so counts stay real", async () => {
  const emptyRoot = path.join(require("node:os").tmpdir(), "dji-empty-fake-device");
  const fakeDevice = { id: "volume:EMPTY:\\", kind: "Windows Mass Storage", path: emptyRoot, label: "SD_Card", fileSystem: "exFAT", cameraModel: "DJI Osmo Action 4 / HG302", score: 100, status: "POSSIBLE_DJI_STORAGE", evidence: { dcim: true } };
  const snapshot = await makePipeline(async () => [fakeDevice]).scan();
  assert.equal(snapshot.devices.some(device => device.id === "offline-sample"), false, "no offline sample when a camera is present");
  assert.equal(snapshot.status, "DEVICE_AND_OFFLINE_MEDIA_SCANNED");
  assert.equal(snapshot.assets.length, 0, "no fixture assets when device DCIM is empty");
});
