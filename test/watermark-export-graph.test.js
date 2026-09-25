const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFilterGraph } = require("../src/renderers/filter-graph-builder");
const { createEffectGraph } = require("../src/color/effect-graph");

const INK = { x: 35, y: 47, width: 398, height: 52 };
const CANVAS = { width: 468, height: 144 };

function build({ overlays = [{ kind: "image", path: "badge.png", enabled: true, scale: 0.25, opacity: 0.8, inkBox: INK, canvasSize: CANVAS }], displayGeometry } = {}, options = {}) {
  return buildFilterGraph({
    graph: createEffectGraph({ overlays, ...(displayGeometry ? { displayGeometry } : {}) }),
    lutRegistry: { get: () => null },
    styleRegistry: null,
    cacheRoot: "unused",
    ...options
  });
}

test("export composites the watermark in the encoder pixel format", async () => {
  const built = await build({}, { videoWidth: 3840, overlayFormat: "yuv420p" });
  assert.match(built.filterGraph, /format=yuv420p\[overlay_base_fmt\]/);
  assert.match(built.filterGraph, /\[overlay_base_fmt\]\[watermark\]overlay=/);
});

test("a known frame width sizes the badge statically instead of per frame", async () => {
  const built = await build({}, { videoWidth: 3840, overlayFormat: "yuv420p" });
  assert.doesNotMatch(built.filterGraph, /scale2ref/);
  // 3840 * 0.25 = 960 wide; 960 * (52/398) = 125.4 -> nearest even 126.
  assert.match(built.filterGraph, /\[watermark_src\]scale=960:126:flags=lanczos\[watermark\]/);
});

test("without a probed width the badge still sizes against the live frame", async () => {
  const built = await build();
  assert.match(built.filterGraph, /scale2ref/);
  assert.doesNotMatch(built.filterGraph, /overlay_base_fmt/);
});

test("geometry that changes the frame keeps the dynamic scale2ref path", async () => {
  const built = await build(
    { displayGeometry: { kind: "display-geometry", enabled: true, rotation: 90, crop: { left: 0, top: 0, right: 0, bottom: 0 } } },
    { videoWidth: 3840, overlayFormat: "yuv420p" }
  );
  assert.match(built.filterGraph, /scale2ref/);
  assert.match(built.filterGraph, /format=yuv420p\[overlay_base_fmt\]/);
});
