const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { ensureThumbnail, ensurePoster, placeholderState, jpegOrientation, isRotatedStill, thumbnailSignature } = require("../src/thumbnail/thumbnail-loader");
const workspaceRoot = path.resolve(__dirname, "..", "..");
const fixture = path.join(workspaceRoot, "dji-test-media");

// A minimal JPEG whose APP1 carries one IFD0 tag: the orientation. Enough for
// the header reader, which is the only thing under test here.
function jpegWithOrientation(orientation) {
  const exif = Buffer.concat([
    Buffer.from("Exif\0\0", "latin1"),
    Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
    Buffer.from([0x01, 0x00]),
    Buffer.from([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0x00])
  ]);
  const header = Buffer.alloc(4);
  header[0] = 0xff; header[1] = 0xe1; header.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), header, exif, Buffer.from([0xff, 0xda, 0x00, 0x02])]);
}

test("THM is preferred when present, then SCR", async () => { const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dji-th-")); const thm = path.join(cacheRoot, "x.THM"); const scr = path.join(cacheRoot, "x.SCR"); fs.writeFileSync(thm, "thm"); fs.writeFileSync(scr, "scr"); const out = await ensureThumbnail({ assetId: "t1", thmPath: thm, scrPath: scr, previewPath: null, originalPath: null, cacheRoot }); assert.equal(fs.readFileSync(out).toString(), "thm"); const out2 = await ensureThumbnail({ assetId: "t2", thmPath: null, scrPath: scr, previewPath: null, originalPath: null, cacheRoot }); assert.equal(fs.readFileSync(out2).toString(), "scr"); });
test("LRF attached JPEG fallback still works on real fixture", async () => { const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dji-th-")); const out = await ensureThumbnail({ assetId: "fixture-a", previewPath: path.join(fixture, "普通色彩.LRF"), originalPath: path.join(fixture, "普通色彩.MP4"), cacheRoot }); assert.ok(out && fs.existsSync(out)); assert.ok(fs.statSync(out).size > 0); });
test("original first frame fallback when preview missing", async () => { const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dji-th-")); const out = await ensureThumbnail({ assetId: "fixture-b", previewPath: null, originalPath: path.join(fixture, "普通色彩.MP4"), cacheRoot }); assert.ok(out && fs.existsSync(out)); });
test("placeholder states are explicit and never broken images", () => { assert.deepEqual(placeholderState(true), { kind: "PLACEHOLDER", label: "NO_THUMBNAIL" }); assert.deepEqual(placeholderState(false), { kind: "PLACEHOLDER", label: "PREVIEW_UNAVAILABLE" }); });
test("poster prefers SCR over LRF attached", async () => { const posterRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dji-po-")); const scr = path.join(posterRoot, "p.SCR"); fs.writeFileSync(scr, "scr"); const out = await ensurePoster({ assetId: "p1", scrPath: scr, previewPath: path.join(fixture, "普通色彩.LRF"), originalPath: null, posterRoot }); assert.equal(fs.readFileSync(out).toString(), "scr"); });

test("orientation is read from the EXIF header and marks a rotated still", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dji-orient-"));
  const portrait = path.join(dir, "DJI_20260924151155_0106_D.JPG");
  const upright = path.join(dir, "plain.JPG");
  fs.writeFileSync(portrait, jpegWithOrientation(6));
  fs.writeFileSync(upright, jpegWithOrientation(1));
  assert.equal(jpegOrientation(portrait), 6);
  assert.equal(jpegOrientation(upright), 1);
  assert.equal(isRotatedStill(portrait), true);
  assert.equal(isRotatedStill(upright), false);
  assert.equal(isRotatedStill(path.join(dir, "clip.MP4")), false);
  assert.equal(jpegOrientation(path.join(dir, "missing.JPG")), null);
});

test("a rotated still is never served from its un-oriented THM companion", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dji-orient-"));
  const original = path.join(dir, "DJI_20260924151155_0106_D.JPG");
  const thm = path.join(dir, "sideways.THM");
  fs.writeFileSync(original, jpegWithOrientation(6));
  fs.writeFileSync(thm, "sideways-thm");
  // ffmpeg cannot run here, so the loader has to fall back: the original carries
  // the orientation and the companion does not.
  const out = await ensureThumbnail({ ffmpeg: path.join(os.tmpdir(), "missing-ffmpeg"), assetId: "rot1", thmPath: thm, scrPath: null, previewPath: null, originalPath: original, cacheRoot: path.join(dir, "cache") });
  assert.equal(fs.readFileSync(out).toString("latin1"), fs.readFileSync(original).toString("latin1"));
});

test("an unrotated still still comes from its companion", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dji-orient-"));
  const original = path.join(dir, "plain.JPG");
  const thm = path.join(dir, "flat.THM");
  fs.writeFileSync(original, jpegWithOrientation(1));
  fs.writeFileSync(thm, "thm-bytes");
  const out = await ensureThumbnail({ assetId: "flat1", thmPath: thm, scrPath: null, previewPath: null, originalPath: original, cacheRoot: path.join(dir, "cache") });
  assert.equal(fs.readFileSync(out).toString(), "thm-bytes");
});

test("a rotated still's cache key follows the original, not the companion", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dji-orient-"));
  const original = path.join(dir, "DJI_20260924151155_0106_D.JPG");
  const thm = path.join(dir, "sideways.THM");
  fs.writeFileSync(original, jpegWithOrientation(6));
  fs.writeFileSync(thm, "sideways-thm");
  const rotated = thumbnailSignature({ thmPath: thm, originalPath: original });
  assert.match(rotated, /^\d+-\d+$/);
  assert.notEqual(rotated, thumbnailSignature({ thmPath: thm, scrPath: null, originalPath: null }));
});
