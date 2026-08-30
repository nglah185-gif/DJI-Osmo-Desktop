function previewFitFilter(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0 && h > 0)) return "";
  // Keep the rawvideo buffer fixed while preserving aspect. Cover-and-crop
  // keeps the preview frame edge-to-edge instead of introducing letterbox bars.
  return `,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-ow)/2:(ih-oh)/2,setsar=1`;
}

module.exports = { previewFitFilter };
