"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCubeText } = require("../src/color/cube-lut");
const { applyLutToRgbFrame } = require("../src/color/lut-engine");
const { cacheName } = require("../src/thumbnail/thumbnail-loader");

function cubeWith(lines) {
  const header = ["LUT_3D_SIZE 2", ...lines];
  const body = [];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) body.push(r + " " + g + " " + b);
  return parseCubeText([...header, ...body].join("\n"), "test");
}

test("a CUBE with an empty domain is rejected instead of producing NaN", () => {
  // domainMax equal to domainMin divides by zero in the sampler, and NaN bytes
  // written into a frame are worse than refusing the file.
  assert.throws(() => cubeWith(["DOMAIN_MIN 0 0 0", "DOMAIN_MAX 0 1 1"]), /empty domain on channel 0/);
  assert.throws(() => cubeWith(["DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 0 1"]), /empty domain on channel 1/);
});

test("a valid CUBE still parses", () => {
  const lut = cubeWith(["DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"]);
  assert.equal(lut.size, 2);
  assert.equal(lut.values.length, 8);
});

test("a LUT returning out-of-range values clamps instead of wrapping", () => {
  // Buffer assignment wraps modulo 256: 510 used to become 254, a violently
  // wrong pixel, while the preview path (Uint8ClampedArray) clamped. The two
  // paths must agree.
  const lut = { size: 2, values: new Array(8).fill([2, 0, 0]) };
  const out = applyLutToRgbFrame(Buffer.from([100, 100, 100]), lut, 1);
  assert.equal(out[0], 255, "over-range must clamp to 255, not wrap to 254");
  assert.equal(out[1], 0);
});

test("an identity LUT leaves the frame untouched", () => {
  const values = [];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) values.push([r, g, b]);
  const frame = Buffer.from([0, 128, 255, 12, 200, 64]);
  assert.deepEqual([...applyLutToRgbFrame(frame, { size: 2, values }, 1)], [...frame]);
});

test("a local-library id cannot become an NTFS alternate data stream", () => {
  // "local:C:\card\a.jpg" written into a filename turns the colon into a
  // stream separator, so the cached thumbnail becomes invisible.
  const name = cacheName("local:D:\\card\\a.jpg", "sig", 116);
  assert.doesNotMatch(name, /[:\\/]/);
  assert.match(name, /-w116\.jpg$/);
});

test("sanitizing the id still keeps the size tiers apart", () => {
  assert.notEqual(cacheName("local:C:/a.jpg", "sig", 116), cacheName("local:C:/a.jpg", "sig", 231));
  assert.equal(cacheName("asset1", "sig", 0), "asset1-sig.jpg");
});
