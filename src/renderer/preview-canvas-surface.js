(() => {
  "use strict";
  /**
   * PreviewCanvasSurface -- paints effect-applied raw RGB24 frames (delivered by
   * the main-side PreviewFrameStreamer over the "preview:frame" IPC channel)
   * into the edit-mode <canvas id="preview-canvas">.
   *
   * Exposed as window.__PreviewCanvasSurface (matches the __vGrid/__sort/
   * __timelineMath/__ThumbScheduler convention used by the other renderer
   * modules), so renderer-phase3.js can build a lightweight surface handle.
   * No GLSL, no color-math re-derivation.
   */
  function create(canvas) {
    if (!canvas || !canvas.getContext) return null;
    const ctx = canvas.getContext("2d");
    let imageData = null;
    let lastW = -1;
    let lastH = -1;

    function paint(frame) {
      const w = (frame && frame.width) | 0;
      const h = (frame && frame.height) | 0;
      const src = frame && frame.data;
      if (!w || !h || !src) return false;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      if (!imageData || lastW !== w || lastH !== h) {
        imageData = new ImageData(w, h);
        lastW = w;
        lastH = h;
      }
      const px = imageData.data;
      // RGB24 (3 bytes/px) -> RGBA (4 bytes/px) for the 2D context.
      for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
        px[j] = src[i];
        px[j + 1] = src[i + 1];
        px[j + 2] = src[i + 2];
        px[j + 3] = 255;
      }
      ctx.putImageData(imageData, 0, 0);
      return true;
    }

    function clear() {
      if (canvas.width && canvas.height) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    return { paint, clear, canvas };
  }

  window.__PreviewCanvasSurface = { create };
})();
