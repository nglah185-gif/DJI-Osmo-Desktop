const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { detectFromBuffer, detectDjiColorMode, sampleColorMode, DLOG_WINDOW, STANDARD_WINDOW } = require("../src/color/dji-color-mode");
const fixture = path.join(__dirname, "..", "..", "dji-test-media");

// Build a synthetic MP4 head holding a djmd-style protobuf sample.
// root: field2(length-delimited) -> videoInfo
// videoInfo: field3 -> streamInfo(...,5=10|8), field4 -> colorInfo({1:1} or empty)
function lenField(tag, payload) {
  const out = Buffer.from([tag]);
  out[0] = tag;
  return Buffer.concat([Buffer.from([tag]), varint(payload.length), payload]);
}
function varint(n) {
  const out = [];
  let v = n;
  while (v >= 0x80) { out.push(0x80 | (v & 0x7f)); v = Math.floor(v / 128); }
  out.push(v);
  return Buffer.from(out);
}
function field1(tag, value) { return Buffer.concat([Buffer.from([tag]), varint(value)]); }
function buildSample(isDlog) {
  const streamInfo = Buffer.concat([
    varint(0x08).length ? Buffer.concat([field1(0x08, 3840), field1(0x10, 2160), field1(0x18, 60), field1(0x20, 1), field1(0x28, isDlog ? 10 : 8), field1(0x30, 4), field1(0x38, 1)]) : Buffer.alloc(0)
  ]);
  const colorInfo = isDlog ? Buffer.concat([field1(0x08, 1)]) : Buffer.alloc(0);
  const videoInfo = Buffer.concat([lenField(0x1a, streamInfo), lenField(0x22, colorInfo)]);
  return lenField(0x12, videoInfo);
}
function buildHead(sample) {
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftyp"), Buffer.from([0, 0, 2, 0]), Buffer.from("isom"), Buffer.from("iso2"), Buffer.from("mp41")]);
  const free = Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from("free")]);
  const mdat = Buffer.concat([Buffer.from([0, 0, 0, 8 + sample.length]), Buffer.from("mdat"), sample]);
  return Buffer.concat([ftyp, free, mdat]);
}

test("synthetic djmd protobuf: D-Log M sample detected", () => {
  const head = buildHead(buildSample(true));
  const r = detectFromBuffer(head);
  assert.equal(r.mode, "D-Log M");
  assert.equal(r.evidence.source, "djmd-protobuf");
  assert.deepEqual(r.evidence.fields, { "2.3.5": 10, "2.4": { "1": 1 } });
});
test("synthetic djmd protobuf: Standard sample detected", () => {
  const head = buildHead(buildSample(false));
  const r = detectFromBuffer(head);
  assert.equal(r.mode, "Standard");
  assert.equal(r.evidence.source, "djmd-protobuf");
});
test("synthetic djmd protobuf: field-2.4-only signal still classifies", () => {
  const a = buildHead(lenField(0x12, lenField(0x22, Buffer.from([0x08, 0x01]))));
  assert.equal(detectFromBuffer(a).mode, "D-Log M");
  const b = buildHead(lenField(0x12, lenField(0x22, Buffer.alloc(0))));
  assert.equal(detectFromBuffer(b).mode, "Standard");
});
test("unknown buffer returns UNKNOWN", () => {
  assert.equal(detectFromBuffer(Buffer.alloc(16)).mode, "UNKNOWN");
  assert.equal(detectFromBuffer(Buffer.from("hello world, not an mp4 at all")).mode, "UNKNOWN");
});
test("window constants match verified real-file markers", () => {
  assert.deepEqual([...DLOG_WINDOW], [0x28, 0x0a, 0x30, 0x04, 0x40, 0x01, 0x22, 0x02, 0x08, 0x01]);
  assert.deepEqual([...STANDARD_WINDOW], [0x28, 0x08, 0x30, 0x04, 0x40, 0x01, 0x22, 0x00]);
});

test("real fixture files are detected correctly (offline dji-test-media)", async () => {
  const cases = [
    ["d log 10bit.MP4", "D-Log M"],
    ["普通色彩.MP4", "Standard"],
    ["高帧率.MP4", "Standard"],
    ["竖屏高帧率视频.MP4", "Standard"]
  ];
  for (const [name, expected] of cases) {
    const r = await detectDjiColorMode(path.join(fixture, name));
    assert.equal(r.mode, expected, name + " -> " + r.mode + " (" + (r.evidence.reason || r.evidence.source) + ")");
    assert.equal(r.evidence.source, "djmd-protobuf");
  }
});
test("real dji-test-media LRF files also carry the marker", async () => {
  const r = await detectDjiColorMode(path.join(fixture, "d log 10bit.LRF"));
  assert.equal(r.mode, "D-Log M");
  const r2 = await detectDjiColorMode(path.join(fixture, "普通色彩.LRF"));
  assert.equal(r2.mode, "Standard");
});
