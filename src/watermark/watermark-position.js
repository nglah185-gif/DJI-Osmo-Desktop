const POSITIONS = Object.freeze({ topLeft: { x: 0, y: 0 }, topRight: { x: 1, y: 0 }, center: { x: 0.5, y: 0.5 }, bottomLeft: { x: 0, y: 1 }, bottomCenter: { x: 0.5, y: 1 }, bottomRight: { x: 1, y: 1 } });
const POSITION_KEYS = Object.freeze(["topLeft", "topRight", "center", "bottomLeft", "bottomCenter", "bottomRight"]);
function positionFrom(value) { if (value && typeof value.x === "number" && typeof value.y === "number") return { x: Math.max(0, Math.min(1, value.x)), y: Math.max(0, Math.min(1, value.y)) }; if (POSITIONS[value]) return POSITIONS[value]; return POSITIONS.bottomCenter; }
function pixelPosition(pos, mainW, mainH, ovW, ovH, margin = 0.04) { const p = positionFrom(pos); const mX = margin * mainW; const mY = margin * mainH; const rangeX = Math.max(0, mainW - ovW - 2 * mX); const rangeY = Math.max(0, mainH - ovH - 2 * mY); return { x: Math.round(p.x * rangeX + mX), y: Math.round(p.y * rangeY + mY) }; }
function overlayExpressions(pos, margin = 0.04) { const p = positionFrom(pos); const mx = (0.04 * margin / 0.04 * 0.0) || 0; void mx; const M = margin; const xBase = "(main_w-overlay_w-2*" + M + "*main_w)"; const yBase = "(main_h-overlay_h-2*" + M + "*main_h)"; const x = p.x === 0 ? (M + "*main_w") : p.x === 1 ? ("(" + xBase + "+" + M + "*main_w)") : ("(((" + xBase + ")/2)+" + M + "*main_w)"); const y = p.y === 0 ? (M + "*main_h") : p.y === 1 ? ("(" + yBase + "+" + M + "*main_h)") : ("(((" + yBase + ")/2)+" + M + "*main_h)"); return { x, y }; }

// Watermark PNGs carry large transparent padding, and the padding differs per
// asset: the 780x288 borderless badge has a 774x72 ink box at (3,108), while
// the 468x144 pic_watermark_oa4_1.png has 398x52 at (35,47). This constant only
// describes the borderless asset and is kept as a last-resort fallback; it is
// NOT valid for other assets, where cropping 774x72 out of a 468x144 canvas
// makes ffmpeg reject the graph with -22 and kills preview and export alike.
// Real ink boxes are measured per asset by watermark-ink-box.js.
const OA4_INK_BOX = Object.freeze({ width: 774, height: 72, x: 3, y: 108 });

// Clamp a measured ink box to the asset canvas so a stale cache entry or a
// swapped asset can never emit an out-of-bounds crop.
function safeInkBox(ink, canvas) {
  const cw = Number(canvas && canvas.width) || 0;
  const ch = Number(canvas && canvas.height) || 0;
  const box = {
    x: Math.max(0, Math.floor(Number(ink && ink.x) || 0)),
    y: Math.max(0, Math.floor(Number(ink && ink.y) || 0)),
    width: Math.floor(Number(ink && ink.width) || 0),
    height: Math.floor(Number(ink && ink.height) || 0)
  };
  if (!(box.width > 0) || !(box.height > 0)) return null;
  if (cw > 0 && ch > 0) {
    if (box.x >= cw || box.y >= ch) return null;
    box.width = Math.min(box.width, cw - box.x);
    box.height = Math.min(box.height, ch - box.y);
    if (!(box.width > 0) || !(box.height > 0)) return null;
  }
  return box;
}

// Reference framing measured from the official still: glyph centre sits at
// 93.0% of frame height, horizontally centred, and the glyph run spans 19.5%
// of frame width. Anchoring the ink CENTRE (instead of an edge plus margin)
// keeps the badge on the same visual line for landscape video, portrait video
// and stills alike.
const INK_CENTER_Y_RATIO = 0.93;
const INK_WIDTH_RATIO = 0.195;

// Uniform scale (h=-1) preserves the ~10.75:1 glyph aspect. The previous graph
// used scale2ref with h=-1, which resolved against the reference frame and
// squashed the badge to ~7:1 while making it 1.8x larger on portrait than on
// landscape footage.
// A standalone scale filter cannot reference the video size, so the badge is
// sized with scale2ref against the video. Inside scale2ref the expressions for
// the scaled input see the REFERENCE frame as iw/ih (main_w refers to the input
// being scaled, i.e. the badge itself, which previously pinned the badge to its
// own 774px width). Height is stated explicitly as ratio*(inkH/inkW) instead of
// -1, because -1 resolved against the reference frame and squashed the glyphs.
function evenPixel(value) {
  // Round to the nearest even number rather than truncating. trunc always floors,
  // which on small frames removes a disproportionate share of the badge height:
  // a 9:16 1080x1920 frame wants h=19.6 and got 18, and a 640x360 preview wanted
  // 11.6 and got 10, distorting the glyph aspect to 11.67:1 and 12.40:1 against
  // the true 10.75:1. Width is large enough that flooring is invisible, but it is
  // rounded the same way for symmetry.
  return Math.max(2, Math.round(Number(value) / 2) * 2);
}
function inkOverlayFilters({ inputIndex, videoLabel, scale = INK_WIDTH_RATIO, opacity = 1, centerYRatio = INK_CENTER_Y_RATIO, ink = OA4_INK_BOX, canvas = null, videoWidth = null }) {
  const s = Math.max(0.01, Math.min(1, Number(scale)));
  const a = Math.max(0, Math.min(1, Number(opacity)));
  const y = Math.max(0, Math.min(1, Number(centerYRatio)));
  const box = safeInkBox(ink, canvas);
  if (!box) throw new Error("Watermark ink box is invalid for the overlay asset");
  const inkAspect = box.height / box.width;
  const crop = "crop=" + box.width + ":" + box.height + ":" + box.x + ":" + box.y;
  const src = "[" + inputIndex + ":v]format=rgba," + crop
    + ",colorchannelmixer=aa=" + a.toFixed(4) + "[watermark_src]";
  // The badge is a looped still whose on-screen size is a fixed fraction of the
  // frame width, so when the frame width is known (export probes it) the target
  // size is a constant and scale2ref is pure overhead: it makes every 4K frame
  // pass through a second scaler on its way to the overlay. The static scale
  // resolves to the exact same numbers scale2ref would, minus the per-frame
  // reference pass. Callers that do not know the frame width -- previews and
  // geometry-driven graphs whose dimensions change before compositing -- keep
  // the dynamic path.
  const width = Number(videoWidth);
  if (Number.isFinite(width) && width > 0) {
    const w = evenPixel(width * s);
    const h = evenPixel(width * s * inkAspect);
    const sized = "[watermark_src]scale=" + w + ":" + h + ":flags=lanczos[watermark]";
    const composite = videoLabel + "[watermark]overlay=x=(main_w-overlay_w)/2:y=(" + y.toFixed(4) + "*main_h-overlay_h/2)[overlay]";
    return { src, sized, composite };
  }
  const evenRound = expr => "round(" + expr + "/2)*2";
  const sized = "[watermark_src]" + videoLabel
    + "scale2ref=w=" + evenRound("iw*" + s.toFixed(4))
    + ":h=" + evenRound("iw*" + (s * inkAspect).toFixed(6))
    + ":flags=lanczos[watermark][overlay_base]";
  const composite = "[overlay_base][watermark]overlay=x=(main_w-overlay_w)/2:y=(" + y.toFixed(4) + "*main_h-overlay_h/2)[overlay]";
  return { src, sized, composite };
}

module.exports = { POSITIONS, POSITION_KEYS, positionFrom, pixelPosition, overlayExpressions, OA4_INK_BOX, INK_CENTER_Y_RATIO, INK_WIDTH_RATIO, inkOverlayFilters, safeInkBox };
