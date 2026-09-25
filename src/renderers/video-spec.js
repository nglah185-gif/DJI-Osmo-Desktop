"use strict";

// Video specification for an export: output resolution, frame rate, rate
// control (quality or target bitrate) and 10-bit encoding. The values are
// intentionally a small closed set so the renderer can trust them without
// re-validating, and so a stale UI cannot ask for a format the pipeline does
// not implement.
//
// "source" keeps whatever the camera recorded. Anything else forces a real
// transcode: a stream copy cannot change resolution, frame rate or bit depth,
// so the passthrough path is disabled the moment a spec is not the default.

const RESOLUTION_HEIGHTS = Object.freeze({ source: null, "2160": 2160, "1440": 1440, "1080": 1080, "720": 720 });
const FRAME_RATES = Object.freeze({ source: null, "60": 60, "50": 50, "30": 30, "25": 25, "24": 24 });
const RATE_MODES = Object.freeze(["quality", "bitrate"]);
const CODECS = Object.freeze(["auto", "h264", "hevc"]);
const MIN_BITRATE_MBPS = 1;
const MAX_BITRATE_MBPS = 500;

function normalizeVideoSpec(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const resolution = Object.prototype.hasOwnProperty.call(RESOLUTION_HEIGHTS, String(raw.resolution)) ? String(raw.resolution) : "source";
  const fps = Object.prototype.hasOwnProperty.call(FRAME_RATES, String(raw.fps)) ? String(raw.fps) : "source";
  const rate = RATE_MODES.includes(raw.rate) ? raw.rate : "quality";
  const requested = Number(raw.bitrateMbps);
  const bitrateMbps = rate === "bitrate" && Number.isFinite(requested) && requested >= MIN_BITRATE_MBPS && requested <= MAX_BITRATE_MBPS
    ? Math.round(requested * 10) / 10
    : (rate === "bitrate" ? 40 : null);
  const codecChoice = CODECS.includes(raw.codec) ? raw.codec : "auto";
  // H.264 has no 10-bit profile the encoders here expose, so "10-bit H.264" is
  // not a request the pipeline can satisfy. A 10-bit request therefore resolves
  // to HEVC even when the codec selector says H.264, rather than silently
  // exporting 8-bit and calling it 10-bit.
  const requestedTenBit = raw.tenBit === true;
  const codec = codecChoice === "auto" ? (requestedTenBit ? "hevc" : "h264") : codecChoice;
  const tenBit = requestedTenBit && codec === "hevc";
  return {
    resolution,
    outputHeight: RESOLUTION_HEIGHTS[resolution],
    fps,
    outputFps: FRAME_RATES[fps],
    rate,
    bitrateMbps,
    videoBitrate: rate === "bitrate" && bitrateMbps ? Math.round(bitrateMbps * 1000000) : null,
    codec,
    codecChoice,
    tenBit
  };
}

function isDefaultVideoSpec(spec) {
  const value = spec || normalizeVideoSpec();
  return value.resolution === "source" && value.fps === "source" && value.rate === "quality" && value.codecChoice === "auto" && value.tenBit === false;
}

// Options for buildFilterGraph: resolution is expressed as an even height, and
// -2 lets the scaler derive an even width so the aspect ratio is preserved.
function videoSpecGraphOptions(spec) {
  const value = spec || normalizeVideoSpec();
  return {
    outputHeight: value.outputHeight,
    outputFps: value.outputFps
  };
}

module.exports = { RESOLUTION_HEIGHTS, FRAME_RATES, RATE_MODES, CODECS, MIN_BITRATE_MBPS, MAX_BITRATE_MBPS, normalizeVideoSpec, isDefaultVideoSpec, videoSpecGraphOptions };
