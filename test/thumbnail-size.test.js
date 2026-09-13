"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { jpegSize, covers, cacheName, ensureThumbnail } = require("../src/thumbnail/thumbnail-loader");

// A minimal but structurally valid JPEG: SOI, an APP0 segment to skip, then an
// SOF0 carrying the frame size. Enough for a header reader, and small enough to
// write inline.
function makeJpeg(width, height) {
  const sof = Buffer.alloc(9);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dji-thumb-"));
}

test("jpegSize reads the frame size out of the header", () => {
  const dir = tempDir();
  const file = path.join(dir, "a.jpg");
  fs.writeFileSync(file, makeJpeg(160, 90));
  assert.deepEqual(jpegSize(file), { width: 160, height: 90 });
  fs.writeFileSync(file, makeJpeg(1280, 720));
  assert.deepEqual(jpegSize(file), { width: 1280, height: 720 });
});

test("jpegSize returns null rather than guessing on unreadable input", () => {
  const dir = tempDir();
  const png = path.join(dir, "a.png");
  // PNG magic: not a JPEG, so the reader must bail instead of inventing a size.
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  assert.equal(jpegSize(png), null);
  assert.equal(jpegSize(path.join(dir, "missing.jpg")), null);
  fs.writeFileSync(path.join(dir, "empty.jpg"), Buffer.alloc(0));
  assert.equal(jpegSize(path.join(dir, "empty.jpg")), null);
});

test("covers accepts a source that is large enough and rejects one that is not", () => {
  const dir = tempDir();
  const small = path.join(dir, "small.jpg");
  const large = path.join(dir, "large.jpg");
  fs.writeFileSync(small, makeJpeg(160, 90));
  fs.writeFileSync(large, makeJpeg(1280, 720));
  // This is the DJI pair: the THM is fine for a 116px list tile and too small
  // for a 231px poster tile, which is what made the poster grid soft.
  assert.equal(covers(small, 116), true);
  assert.equal(covers(small, 231), false);
  assert.equal(covers(large, 231), true);
  // No size requirement, or no readable size, must not cost the user a thumbnail.
  assert.equal(covers(small, 0), true);
  assert.equal(covers(path.join(dir, "missing.jpg"), 231), true);
});

test("the cache key separates size tiers so they cannot overwrite each other", () => {
  const list = cacheName("asset1", "sig", 116);
  const poster = cacheName("asset1", "sig", 231);
  assert.notEqual(list, poster);
  assert.match(list, /-w116\.jpg$/);
  assert.match(poster, /-w231\.jpg$/);
  assert.equal(cacheName("asset1", "sig", 0), "asset1-sig.jpg");
});

test("thumbnails pick the source that covers the requested width", async () => {
  const dir = tempDir();
  const thm = path.join(dir, "clip.THM");
  const scr = path.join(dir, "clip.SCR");
  fs.writeFileSync(thm, makeJpeg(160, 90));
  fs.writeFileSync(scr, makeJpeg(1280, 720));

  // A dense list tile is served by the 2 KB THM: the fast path is preserved.
  const listOut = await ensureThumbnail({ assetId: "list-asset", thmPath: thm, scrPath: scr, cacheRoot: dir, minWidth: 116 });
  assert.deepEqual(jpegSize(listOut), { width: 160, height: 90 });

  // A poster tile must not be an upscaled 160px image.
  const posterOut = await ensureThumbnail({ assetId: "poster-asset", thmPath: thm, scrPath: scr, cacheRoot: dir, minWidth: 231 });
  assert.deepEqual(jpegSize(posterOut), { width: 1280, height: 720 });
});

test("an undersized source still yields a thumbnail when nothing larger exists", async () => {
  const dir = tempDir();
  const thm = path.join(dir, "only.THM");
  fs.writeFileSync(thm, makeJpeg(160, 90));
  // No SCR and no preview: a blurry tile beats no tile.
  const out = await ensureThumbnail({ assetId: "lonely", thmPath: thm, cacheRoot: dir, minWidth: 231 });
  assert.ok(out && fs.existsSync(out));
  assert.deepEqual(jpegSize(out), { width: 160, height: 90 });
});
