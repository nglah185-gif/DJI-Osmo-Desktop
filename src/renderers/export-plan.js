"use strict";

// Export planning: decide whether an export has to decode and re-encode video
// at all, and how hard to work when it does.
//
// Measured on the real 4K HEVC 10-bit source (DJI_20260822182300_0362_D.MP4,
// 566 MB, 43s, read off the camera over USB):
//
//   current pipeline (libx264 medium, rgb24 filters)   296.0s    1.9 MB/s
//   stream copy (-c copy)                              16.2s    35.0 MB/s
//
// 35 MB/s is not a coincidence and it is not our number to improve: it is what
// the camera's card interface delivers, and it is the same figure the reference
// app reaches. Once video is copied instead of re-encoded the export becomes
// pure I/O and finishes at the speed of the cable. That is the entire win, and
// it applies to every export where the user changed nothing about the picture,
// which is the common case for offloading footage.
//
// So the plan has two modes:
//
//   PASSTHROUGH  no picture change  -> -c:v copy, I/O bound, ~18x faster
//   TRANSCODE    picture changed    -> decode, filter, encode
//
// Trimming does NOT force a transcode. This source carries a keyframe every
// 0.50s (measured, GOP is fixed), so a trimmed copy can start on a keyframe
// with at most half a second of lead-in. -ss before -i seeks to the preceding
// keyframe, which is exactly the behavior we want here.
//
// Anything that alters pixels, timing, or geometry forces TRANSCODE. The list is
// deliberately explicit rather than a hash comparison against a default graph:
// a new effect must be classified on purpose, and the failure direction for an
// unrecognized field is "re-encode", never "silently copy and drop the effect".

const PASSTHROUGH = "passthrough";
const TRANSCODE = "transcode";

// Reasons are returned rather than logged so callers can surface why an export
// took the slow path, and so tests can assert on the specific trigger.
function planExport({ graph = null, clip = null, previewSize = null } = {}) {
  const reasons = [];
  if (previewSize && Number(previewSize.width) > 0 && Number(previewSize.height) > 0) reasons.push("preview-scale");
  reasons.push(...graphReasons(graph));
  reasons.push(...clipReasons(clip));
  return { mode: reasons.length ? TRANSCODE : PASSTHROUGH, reasons };
}

function graphReasons(graph) {
  if (!graph) return [];
  const reasons = [];
  const geometry = graph.displayGeometry;
  if (geometry && geometry.enabled !== false) {
    const crop = geometry.crop || {};
    if (positive(crop.left) || positive(crop.top) || positive(crop.right) || positive(crop.bottom)) reasons.push("crop");
    if (Number(geometry.rotation || 0) !== 0) reasons.push("rotation");
    if (geometry.flipHorizontal) reasons.push("flip-horizontal");
    if (geometry.flipVertical) reasons.push("flip-vertical");
  }
  // A technical transform only reaches the filter graph when colorTransform is
  // enabled AND carries a profile, matching buildFilterGraph. An enabled node
  // with a null profile emits no filter, so it must not force a transcode.
  const colorTransform = graph.colorTransform;
  if (colorTransform && colorTransform.enabled && colorTransform.colorProfile) reasons.push("color-transform");
  if (Array.isArray(graph.styleStack) && graph.styleStack.length) reasons.push("style-stack");
  if (Array.isArray(graph.adjustments) && graph.adjustments.some(isEffectiveAdjustment)) reasons.push("adjustments");
  if (Array.isArray(graph.overlays) && graph.overlays.some(item => item && item.enabled !== false && item.kind === "image" && item.path)) reasons.push("overlay");
  return reasons;
}

// An adjustment present at its identity value changes nothing. The renderer
// still builds an `eq` filter for it, so treating "present" as "changes pixels"
// would send an untouched clip down the 296s path. Identity differs per
// adjustment: exposure is additive (0), contrast and saturation multiplicative
// (1), and eq's own defaults agree with those.
const ADJUSTMENT_IDENTITY = { exposure: 0, contrast: 1, saturation: 1 };

function isEffectiveAdjustment(item) {
  if (!item || !item.id) return false;
  if (!Object.prototype.hasOwnProperty.call(ADJUSTMENT_IDENTITY, item.id)) return true;
  const identity = ADJUSTMENT_IDENTITY[item.id];
  const value = Number(item.value ?? identity);
  if (!Number.isFinite(value)) return false;
  // Slider values arrive as floats. Comparing exactly would let 1.0000001 from
  // a UI round-trip force a full re-encode.
  return Math.abs(value - identity) > 1e-6;
}

function clipReasons(clip) {
  if (!clip) return [];
  const reasons = [];
  const speed = Number(clip.playbackRate ?? 1);
  if (Number.isFinite(speed) && Math.abs(speed - 1) > 1e-6) reasons.push("playback-rate");
  return reasons;
}

function positive(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0;
}

// Audio is planned separately from video. Trimming and muting need no audio
// re-encode, but a speed or volume change does. Copying AAC when it is already
// AAC saves a full decode/encode pass on the audio stream, and on a passthrough
// export it is what keeps the whole operation at cable speed.
function planAudio({ clip = null, sourceCodec = null } = {}) {
  if (clip && (clip.muted || Number(clip.volume ?? 1) === 0)) return { mode: "drop", reasons: ["muted"] };
  const reasons = [];
  const speed = Number(clip ? clip.playbackRate ?? 1 : 1);
  if (Number.isFinite(speed) && Math.abs(speed - 1) > 1e-6) reasons.push("playback-rate");
  const volume = Number(clip ? clip.volume ?? 1 : 1);
  if (Number.isFinite(volume) && Math.abs(volume - 1) > 1e-6) reasons.push("volume");
  if (reasons.length) return { mode: "encode", reasons };
  // Only codecs that are legal in MP4 can be copied. Anything else (PCM from a
  // wav, for example) has to be encoded even when untouched.
  const copyable = /^(aac|mp3|ac3|eac3|alac|opus)$/i.test(String(sourceCodec || ""));
  return copyable ? { mode: "copy", reasons: [] } : { mode: "encode", reasons: sourceCodec ? ["codec-" + sourceCodec] : ["unknown-codec"] };
}

module.exports = { PASSTHROUGH, TRANSCODE, planExport, planAudio, isEffectiveAdjustment, ADJUSTMENT_IDENTITY };
