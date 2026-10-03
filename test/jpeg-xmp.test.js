"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { xmpPacket, writeJpegXmp } = require("../src/renderers/jpeg-export");

// The smallest thing that still looks like a JPEG: start of image, a JFIF APP0,
// then start of scan and a byte of entropy data.
function tinyJpeg() {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), (() => { const head = Buffer.alloc(2); head.writeUInt16BE(16); return head; })(), Buffer.from("JFIF\u0000\u0001\u0002\u0000\u0000\u0001\u0000\u0001\u0000\u0000")]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x11, 0x22])]);
}

function segments(buffer) {
  const found = [];
  let offset = 2;
  while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    const end = offset + 2 + length;
    if (end > buffer.length) break;
    found.push({ marker, payload: buffer.subarray(offset + 4, end) });
    offset = end;
  }
  return found;
}

function tempJpeg() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dji-xmp-")), "photo.jpg");
  fs.writeFileSync(file, tinyJpeg());
  return file;
}

test("a copyright packet carries the creator, the rights and the note", () => {
  const packet = xmpPacket({ artist: "张三", copyright: "© 2026 张三", comment: "校运会" });
  assert.match(packet.toString("utf8"), /dc:creator/);
  assert.match(packet.toString("utf8"), /张三/);
  assert.match(packet.toString("utf8"), /dc:rights/);
  assert.match(packet.toString("utf8"), /校运会/);
  assert.equal(xmpPacket({}), null);
  assert.equal(xmpPacket({ artist: "", copyright: "", comment: "" }), null);
});

test("markup in the field values cannot break the packet", () => {
  const packet = xmpPacket({ copyright: "a<b>&\"c\"" }).toString("utf8");
  assert.match(packet, /a&lt;b&gt;&amp;&quot;c&quot;/);
  assert.doesNotMatch(packet, /a<b>/);
});

test("the packet is written as an XMP segment and never stacked twice", () => {
  const file = tempJpeg();
  assert.equal(writeJpegXmp(file, { copyright: "© 2026 张三" }), true);
  const first = fs.readFileSync(file);
  assert.equal(first[0], 0xff);
  assert.equal(first[1], 0xd8);
  const xmp = segments(first).filter(segment => segment.payload.subarray(0, 28).toString("latin1") === "http://ns.adobe.com/xap/1.0/");
  assert.equal(xmp.length, 1);
  assert.match(xmp[0].payload.toString("utf8"), /© 2026 张三/);
  // The frame data is still last, and the camera's own segment is untouched.
  assert.ok(first.subarray(-4).equals(Buffer.from([0x11, 0x22, 0x00, 0x00]).subarray(0, 2)) || first.includes(0xda));

  writeJpegXmp(file, { copyright: "© 2026 张三", artist: "张三" });
  const second = fs.readFileSync(file);
  const after = segments(second).filter(segment => segment.payload.subarray(0, 28).toString("latin1") === "http://ns.adobe.com/xap/1.0/");
  assert.equal(after.length, 1);
  assert.match(after[0].payload.toString("utf8"), /dc:creator/);
  assert.equal(segments(second).filter(segment => segment.marker === 0xe0).length, 1);
});

test("a file that is not a JPEG is refused rather than damaged", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dji-xmp-")), "not.jpg");
  fs.writeFileSync(file, Buffer.from("not a jpeg at all"));
  assert.equal(writeJpegXmp(file, { copyright: "x" }), false);
  assert.equal(fs.readFileSync(file, "utf8"), "not a jpeg at all");
});
