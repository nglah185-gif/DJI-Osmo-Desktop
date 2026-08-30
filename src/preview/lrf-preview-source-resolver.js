class LrfPreviewSourceResolver {
  resolve(asset) {
    if (!asset || !asset.preview || asset.preview === "UNKNOWN") return { status: "PREVIEW_UNAVAILABLE", path: null, durationMs: null };
    return { status: "READY", path: asset.preview.path, durationMs: typeof asset.preview.probe.duration === "number" ? Math.round(asset.preview.probe.duration * 1000) : null };
  }
}
module.exports = { LrfPreviewSourceResolver };
