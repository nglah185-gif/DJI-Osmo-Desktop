const test = require("node:test");
const assert = require("node:assert/strict");
const state = require("../src/renderer/video-export-options");

test("the default payload is the source-everything spec", () => {
  const initial = state.initialState();
  assert.deepEqual(state.payload(initial), { resolution: "source", fps: "source", rate: "quality", codec: "auto", bitrateMbps: state.DEFAULT_BITRATE_MBPS, tenBit: false });
  assert.equal(state.view(initial).isDefault, true);
  assert.equal(state.view(initial).tenBitDisabled, false);
});

test("H.264 and 10-bit are kept mutually exclusive", () => {
  // Choosing H.264 clears 10-bit...
  const h264 = state.setCodec(state.setTenBit(state.initialState(), true), "h264");
  assert.equal(h264.codec, "h264");
  assert.equal(h264.tenBit, false);
  assert.equal(state.view(h264).tenBitDisabled, true);
  // ...and asking for 10-bit moves the codec selector off H.264.
  const tenBit = state.setTenBit(h264, true);
  assert.equal(tenBit.tenBit, true);
  assert.equal(tenBit.codec, "hevc");
  // Auto stays auto: the engine resolves 10-bit Auto to HEVC.
  const auto = state.setTenBit(state.initialState(), true);
  assert.equal(auto.codec, "auto");
  assert.equal(auto.tenBit, true);
});

test("unknown select values are ignored rather than stored", () => {
  const initial = state.initialState();
  assert.equal(state.setResolution(initial, "4320"), initial);
  assert.equal(state.setFps(initial, "120"), initial);
  assert.equal(state.setRate(initial, "cbr"), initial);
});

test("bitrate is clamped and only visible in bitrate mode", () => {
  let current = state.setRate(state.initialState(), "bitrate");
  assert.equal(state.view(current).bitrateVisible, true);
  current = state.setBitrate(current, 9999);
  assert.equal(current.bitrateMbps, state.MAX_BITRATE_MBPS);
  current = state.setBitrate(current, 0.1);
  assert.equal(current.bitrateMbps, state.MIN_BITRATE_MBPS);
  assert.equal(state.view(state.setRate(current, "quality")).bitrateVisible, false);
});

test("any non-default choice marks the spec custom", () => {
  assert.equal(state.isDefaultSpec(state.setResolution(state.initialState(), "1080")), false);
  assert.equal(state.isDefaultSpec(state.setFps(state.initialState(), "60")), false);
  assert.equal(state.isDefaultSpec(state.setTenBit(state.initialState(), true)), false);
  assert.equal(state.isDefaultSpec(state.setRate(state.initialState(), "bitrate")), false);
});

test("the payload carries 10-bit through unchanged", () => {
  const current = state.setTenBit(state.setResolution(state.initialState(), "720"), true);
  assert.deepEqual(state.payload(current), { resolution: "720", fps: "source", rate: "quality", codec: "auto", bitrateMbps: state.DEFAULT_BITRATE_MBPS, tenBit: true });
});
