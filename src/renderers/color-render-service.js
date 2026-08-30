const path = require("node:path");
const { FfmpegFrameRenderer } = require("./ffmpeg-frame-renderer");
const { FfmpegExportRenderer } = require("./ffmpeg-export-renderer");

class ColorRenderService {
  constructor({ root, lutRegistry, styleRegistry, ffmpegPath = null, cacheRoot = null }) { this.root = root; this.lutRegistry = lutRegistry; this.styleRegistry = styleRegistry; this.frameRenderer = new FfmpegFrameRenderer({ ffmpegPath, cacheRoot }); this.exportRenderer = new FfmpegExportRenderer({ ffmpegPath, cacheRoot }); }
  async renderPreviewFrame(inputPath, timestampSeconds, graph, width = null, height = null) { const result = await this.frameRenderer.render({ inputPath, timestampSeconds, graph, lutRegistry: this.lutRegistry, styleRegistry: this.styleRegistry, width, height }); return { dataUrl: "data:image/png;base64," + result.png.toString("base64"), elapsedMs: result.elapsedMs, filterGraph: result.filterGraph, generatedLuts: result.generatedLuts }; }
  async exportOriginal(inputPath, outputPath, graph, durationSeconds = null, timestampSeconds = null, clip = null, onProgress = null, signal = null) { return this.exportRenderer.render({ inputPath, outputPath, graph, lutRegistry: this.lutRegistry, styleRegistry: this.styleRegistry, durationSeconds, timestampSeconds, clip, onProgress, signal }); }
  defaultExportPath(assetName, preset = "color", exportDir = null) {
    const clean = value => String(value).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_").replace(/[. ]+$/g, "").trim();
    const stem = clean(path.basename(assetName, path.extname(assetName))) || "export";
    const suffix = clean(preset) || "color";
    return path.join(exportDir || path.join(this.root, "artifacts", "exports"), stem + "." + suffix + ".mp4");
  }
}
module.exports = { ColorRenderService };
