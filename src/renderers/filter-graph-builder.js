// Working pixel format for the filter chain.
//
// This was rgb24 at three separate points in the graph. rgb24 is 8-bit, and the
// camera's D-Log M footage is 10-bit, so every export quantized the source down
// to 8 bits before the LUT was applied and lost precision in exactly the
// gradients (sky, shadow rolloff) that a log profile exists to preserve.
//
// It was also the slowest possible choice. At 4K, rgb24 is 24.9 MB per frame
// versus 12.4 MB for yuv420p10le, and the packed RGB paths in ffmpeg's scaler
// are not as well optimized as the planar YUV ones. Three conversions per frame
// on top of that meant the pipeline moved ~1.5 GB/s through single-threaded
// filters before x264 saw anything.
//
// yuv420p10le keeps 10-bit precision through the chain at half the bandwidth.
// lut3d, eq, crop, transpose, and haldclut all operate on it directly, so no
// conversion is inserted; ffmpeg only converts once at the encoder, where the
// pixel format is dictated by the output anyway.
const WORKING_FORMAT = "yuv420p10le";

async function buildFilterGraph({ graph, lutRegistry, styleRegistry, cacheRoot, workingFormat = WORKING_FORMAT, outputFormat = WORKING_FORMAT, inputPrefix = "", outputSuffix = "" }) {
  const filters = []; const inputs = []; let videoLabel = "[working_rgb]"; let inputIndex = 1; const generatedLuts = [];
  const source = graph.sourceTransform || { enabled: true };
  // inputPrefix is where the export's speed filter (setpts) goes: it has to act
  // on the source before anything else measures time.
  filters.push("[0:v]" + (inputPrefix || "") + "format=" + workingFormat + "[input_interpreted]");
  videoLabel = "[input_interpreted]";
  const geometry = graph.displayGeometry || {};
  if (geometry.enabled !== false) {
    const crop = geometry.crop || {}; const left = Math.max(0, Number(crop.left || 0)); const top = Math.max(0, Number(crop.top || 0)); const right = Math.max(0, Number(crop.right || 0)); const bottom = Math.max(0, Number(crop.bottom || 0));
    if (left || top || right || bottom) {
      // libx264/yuv420p requires even dimensions. Fractional crop values can
      // otherwise produce an odd width (for example 3379px) and make export
      // fail only after ffmpeg has spent time decoding the clip.
      filters.push(videoLabel + "crop=iw*(1-" + (left + right).toFixed(6) + "):ih*(1-" + (top + bottom).toFixed(6) + "):iw*" + left.toFixed(6) + ":ih*" + top.toFixed(6) + ",scale=trunc(iw/2)*2:trunc(ih/2)*2[cropped]");
      videoLabel = "[cropped]";
    }
    const rotation = Number(geometry.rotation || 0);
    if (rotation === 90) { filters.push(videoLabel + "transpose=1[geometry]"); videoLabel = "[geometry]"; }
    else if (rotation === 180) { filters.push(videoLabel + "hflip,vflip[geometry]"); videoLabel = "[geometry]"; }
    else if (rotation === 270) { filters.push(videoLabel + "transpose=2[geometry]"); videoLabel = "[geometry]"; }
    if (geometry.flipHorizontal) { filters.push(videoLabel + "hflip[geometry_h]"); videoLabel = "[geometry_h]"; }
    if (geometry.flipVertical) { filters.push(videoLabel + "vflip[geometry_v]"); videoLabel = "[geometry_v]"; }
  }
  const profile = graph.colorTransform && graph.colorTransform.enabled ? graph.colorTransform.colorProfile : null;
  const technical = profile && profile.technicalTransformId ? lutRegistry.get(profile.technicalTransformId) : null;
  if (technical) {
    if (technical.availability !== "OFFICIAL_PIPELINE" || technical.role !== "TECHNICAL_TRANSFORM") throw new Error("Technical transform is not an official V2 resource: " + technical.resourceId);
    if (technical.cameraFamily !== profile.cameraFamily) throw new Error("Technical transform camera family does not match ColorProfile");
    if (technical.sha256 !== profile.technicalTransformSha256) throw new Error("Technical transform hash does not match ColorProfile");
    // haldclut is the one stage that genuinely needs RGB: the identity image and
    // the frame have to agree, and the HALD image itself is 8-bit RGB. rgb48le
    // keeps the frame's 10 bits intact through the lookup instead of throwing
    // them away as rgb24 did.
    if (technical.format === "HALD") { inputs.push("-loop", "1", "-i", technical.path); filters.push(videoLabel + "format=rgb48le[technical_base];[" + inputIndex + ":v]format=rgb48le[technical_lut];[technical_base][technical_lut]haldclut[technical_out]"); videoLabel = "[technical_out]"; inputIndex++; }
    else if (technical.format === "CUBE") { filters.push(videoLabel + "lut3d=file='" + escapeFilterPath(technical.path) + "'[technical_out]"); videoLabel = "[technical_out]"; }
    else throw new Error("Unsupported technical LUT format: " + technical.format);
  }
  // Back to the working format after the technical LUT. When no HALD stage ran
  // the frame is already in this format and ffmpeg drops the stage, so this
  // costs nothing in the common case while still guaranteeing a known format
  // for the creative LUTs and eq that follow.
  filters.push(videoLabel + "format=" + workingFormat + "[working_rgb]"); videoLabel = "[working_rgb]";
  for (let index = 0; index < (graph.styleStack || []).length; index++) {
    const style = graph.styleStack[index]; const creative = style.resourceId ? lutRegistry.get(style.resourceId) : null;
    if (!creative || creative.availability !== "OFFICIAL_PIPELINE" || creative.role !== "CREATIVE_LOOK" || creative.inputColorSpace !== "Rec.709" || creative.outputColorSpace !== "Rec.709") throw new Error("Creative look must be an official Rec.709 CUBE resource");
    const lutLabel = "style" + index + "_lut"; filters.push(videoLabel + "lut3d=file='" + escapeFilterPath(creative.path) + "'[" + lutLabel + "]"); videoLabel = "[" + lutLabel + "]";
  }
  const adjustments = Array.isArray(graph.adjustments) ? graph.adjustments : []; const exposure = adjustments.find(item => item.id === "exposure"); const contrast = adjustments.find(item => item.id === "contrast"); const saturation = adjustments.find(item => item.id === "saturation");
  if (exposure || contrast || saturation) { const values = []; if (exposure) values.push("brightness=" + (Number(exposure.value || 0) / 4).toFixed(6)); if (contrast) values.push("contrast=" + Number(contrast.value || 1).toFixed(6)); if (saturation) values.push("saturation=" + Number(saturation.value || 1).toFixed(6)); filters.push(videoLabel + "eq=" + values.join(":") + "[adjusted]"); videoLabel = "[adjusted]"; }
  const overlay = Array.isArray(graph.overlays) ? graph.overlays.find(item => item.enabled !== false) : null;
  if (overlay && overlay.kind === "image" && overlay.path) {
    inputs.push("-loop", "1", "-i", overlay.path);
    const scale = Math.max(0.01, Math.min(1, Number(overlay.scale || INK_WIDTH_RATIO)));
    const opacity = Math.max(0, Math.min(1, Number(overlay.opacity ?? 1)));
    // inkBox is measured from the asset's own alpha channel. OA4_INK_BOX only
    // describes the borderless badge, so it is a fallback of last resort: using
    // it for a differently sized asset produces an out-of-bounds crop that fails
    // the entire graph with -22 instead of merely misplacing the mark.
    // Resolve the canvas from the asset itself when the caller did not supply
    // it, so safeInkBox can always clamp. Without a canvas an unmeasured asset
    // fell through to OA4_INK_BOX unchecked: the 468x144 pic_watermark_oa4_1.png
    // got cropped 774x72 at (3,108) and ffmpeg killed the whole graph with -22.
    const canvas = overlay.canvasSize || pngCanvasSize(overlay.path) || null;
    // Prefer the measured ink box. Otherwise fall back to the asset's OWN full
    // canvas, which is always in bounds, rather than another asset's ink box.
    const ink = overlay.inkBox || (canvas ? { x: 0, y: 0, width: canvas.width, height: canvas.height } : OA4_INK_BOX);
    const centerYRatio = Number.isFinite(Number(overlay.centerYRatio)) ? Number(overlay.centerYRatio) : INK_CENTER_Y_RATIO;
    const parts = inkOverlayFilters({ inputIndex, videoLabel, scale, opacity, centerYRatio, ink, canvas });
    filters.push(parts.src);
    filters.push(parts.sized);
    filters.push(parts.composite);
    videoLabel = "[overlay]";
    inputIndex++;
  } else { filters.push(videoLabel + "null[overlay]"); videoLabel = "[overlay]"; }
  // Scale and pad only after rotation, crop, and watermark compositing. This
  // keeps semantic anchors (for example bottom-right) tied to the actual
  // oriented frame instead of the fixed preview canvas.
  const previewSize = graph && graph.previewSize;
  if (previewSize && Number(previewSize.width) > 0 && Number(previewSize.height) > 0) {
    const previewWidth = Math.max(2, Math.floor(Number(previewSize.width) / 2) * 2);
    const previewHeight = Math.max(2, Math.floor(Number(previewSize.height) / 2) * 2);
    filters.push(videoLabel + "scale=" + previewWidth + ":" + previewHeight + ":force_original_aspect_ratio=decrease,pad=" + previewWidth + ":" + previewHeight + ":(ow-iw)/2:(oh-ih)/2:color=black[preview_scaled]");
    videoLabel = "[preview_scaled]";
  }
  // The output format is the caller's decision, not the graph's. Preview
  // consumers read raw rgb24 over a pipe and must keep it; export hands frames
  // to an encoder and should stay in planar YUV so no needless conversion
  // happens on the way out.
  //
  // outputSuffix carries the preview fit filter. Both of these used to be
  // applied by string-replacing "format=rgb24[outv]" at the call site, which
  // silently became a no-op the moment this line changed -- the export path had
  // the same problem with "[0:v]format=rgb24" and its speed filter. Passing them
  // in means a mismatch is a visible error instead of a dropped filter.
  filters.push(videoLabel + "format=" + outputFormat + (outputSuffix || "") + "[outv]");
  return { inputArgs: inputs, filterGraph: filters.join(";"), generatedLuts, stages: ["SOURCE", "INPUT_COLOR_INTERPRETATION", "TECHNICAL_COLOR_TRANSFORM", "REC709_WORKING_SPACE", "CREATIVE_STYLE", "ADJUSTMENTS", "OVERLAY", "OUTPUT"], inputInterpretation: source, workingFormat, outputFormat };
}
const { overlayExpressions, inkOverlayFilters, OA4_INK_BOX, INK_CENTER_Y_RATIO, INK_WIDTH_RATIO } = require("../watermark/watermark-position");
const { pngCanvasSize } = require("../watermark/watermark-ink-box");
void overlayExpressions;
function escapeFilterPath(value) { return String(value).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'"); }
module.exports = { buildFilterGraph, escapeFilterPath };
