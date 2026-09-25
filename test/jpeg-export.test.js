const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { copyJpegMetadata, parseExifStamp, parseNameStamp, stampCaptureTime, jpegWatermarkFilters, buildJpegExportArgs, exportJpeg } = require("../src/renderers/jpeg-export");

function segment(marker, payload) {
  const buffer = Buffer.alloc(4 + payload.length);
  buffer[0] = 0xff;
  buffer[1] = marker;
  buffer.writeUInt16BE(payload.length + 2, 2);
  payload.copy(buffer, 4);
  return buffer;
}
const SOI = Buffer.from([0xff, 0xd8]);
const SOS = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 7, 8]);
const EXIF = segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00])]));

function workDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dji-jpeg-" + label + "-"));
  return dir;
}

test("a watermarked JPEG keeps the camera's EXIF, ahead of the scan data", () => {
  const dir = workDir("metadata");
  const source = path.join(dir, "source.jpg");
  const target = path.join(dir, "target.jpg");
  const sourceScan = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  fs.writeFileSync(source, Buffer.concat([SOI, segment(0xe0, Buffer.from("JFIF\0\1\1\0\0\1\0\1\0\0")), EXIF, SOS, sourceScan]));
  fs.writeFileSync(target, Buffer.concat([SOI, segment(0xe0, Buffer.from("JFIF\0\1\1\0\0\1\0\1\0\0")), SOS, Buffer.from([0x11, 0x22, 0x33])]));

  assert.equal(copyJpegMetadata(source, target), true);
  const written = fs.readFileSync(target);
  const exifAt = written.indexOf(Buffer.from("Exif\0\0", "latin1"));
  const scanAt = written.indexOf(SOS);
  assert.ok(exifAt > 0, "EXIF must be carried into the export");
  assert.ok(exifAt < scanAt, "EXIF must sit before the scan data");
  assert.equal(written.includes(sourceScan), false, "the source's scan data must not be copied");
  assert.equal(written.includes(Buffer.from([0x11, 0x22, 0x33])), true, "the encoded scan data must survive");
});

test("a source with no metadata segments is reported, not guessed", () => {
  const dir = workDir("nometa");
  const source = path.join(dir, "plain.jpg");
  const target = path.join(dir, "plain-target.jpg");
  const plain = Buffer.concat([SOI, SOS, Buffer.from([1])]);
  fs.writeFileSync(source, plain);
  fs.writeFileSync(target, plain);
  assert.equal(copyJpegMetadata(source, target), false);
});

test("capture stamps are read from the DJI file name and rejected when implausible", () => {
  assert.equal(parseNameStamp("DJI_20260712172028_0001_D (2).MP4").getFullYear(), 2026);
  assert.equal(parseNameStamp("DJI_20260712172028_0001_D (2).MP4").getMonth(), 6);
  assert.equal(parseNameStamp("DJI_20260712172028_0001_D (2).MP4").getHours(), 17);
  assert.equal(parseExifStamp("2026:07:27 23:55:33").getSeconds(), 33);
  assert.equal(parseExifStamp("0000:00:00 00:00:00"), null);
  assert.equal(parseNameStamp("no timestamp here"), null);
  assert.equal(parseExifStamp("clap 2026:07:27 23:55:33"), null);
});

test("an exported photo carries the capture time from its name", async () => {
  const dir = workDir("stamp");
  const source = path.join(dir, "DJI_20260712172028_0001_D.JPG");
  const output = path.join(dir, "DJI_20260712172028_0001_D (2).JPG");
  fs.writeFileSync(source, Buffer.concat([SOI, SOS, Buffer.from([1, 2, 3])]));

  const result = await exportJpeg({ ffmpegPath: "ffmpeg", inputPath: source, outputPath: output });
  assert.equal(result.bytes, fs.statSync(output).size);
  assert.equal(result.metadataCopied, true);
  const stamped = fs.statSync(output).mtime;
  assert.equal(stamped.getFullYear(), 2026);
  assert.equal(stamped.getMonth(), 6);
  assert.equal(stamped.getHours(), 17);
});

test("a failed still export leaves no temporary or half-written file behind", async () => {
  const dir = workDir("failure");
  const source = path.join(dir, "source.jpg");
  const output = path.join(dir, "out.jpg");
  fs.writeFileSync(source, Buffer.concat([SOI, SOS, Buffer.from([1])]));
  // No ink box, so the watermark branch is not taken; the copy branch must
  // still refuse to write on top of the source it was handed.
  await assert.rejects(() => exportJpeg({ ffmpegPath: "ffmpeg", inputPath: source, outputPath: source }), /different from the source/);
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.startsWith(".dji-photo-")), []);
});

test("the still graph pins encoder quality and ends in a single mappable pad", () => {
  const args = buildJpegExportArgs({ inputPath: "in.jpg", outputPath: "out.jpg", watermarkPath: "badge.png", filterGraph: "[out]" });
  assert.deepEqual(args.slice(args.indexOf("-q:v"), args.indexOf("-q:v") + 6), ["-q:v", "1", "-qmin", "1", "-qmax", "1"]);
  assert.equal(args.includes("-frames:v"), true);
  assert.deepEqual(args.slice(-1), ["out.jpg"]);
  const chain = jpegWatermarkFilters({ inkBox: { width: 100, height: 20 } });
  assert.match(chain, /\[overlay\]format=yuvj420p\[out\]$/);
});

test("stamping a file with no capture time leaves it alone", () => {
  const dir = workDir("nostamp");
  const file = path.join(dir, "file.bin");
  fs.writeFileSync(file, "x");
  const before = fs.statSync(file).mtimeMs;
  stampCaptureTime(file, null);
  assert.equal(fs.statSync(file).mtimeMs, before);
});
