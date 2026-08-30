const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inkBoxFromAlpha, InkBoxCache } = require("../src/watermark/watermark-ink-box");
const { buildFilterGraph } = require("../src/renderers/filter-graph-builder");
const { createEffectGraph } = require("../src/color/effect-graph");
const { safeInkBox, OA4_INK_BOX } = require("../src/watermark/watermark-position");

// Regression: a single hardcoded ink box was applied to every badge asset. The
// shipped assets do not share a canvas (780x288 borderless vs 468x144 numbered
// styles), so cropping 774x72 out of a 468x144 canvas made ffmpeg abort the
// whole graph with -22 "Invalid argument" and left preview and export broken for
// every style except borderless.

function alphaCanvas(width, height, box) {
  const buffer = Buffer.alloc(width * height, 0);
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) buffer[y * width + x] = 255;
  }
  return buffer;
}

test("ink box scan finds the tight glyph bounds and ignores transparent padding", () => {
  const box = { x: 35, y: 47, width: 398, height: 52 };
  const measured = inkBoxFromAlpha(alphaCanvas(468, 144, box), 468, 144);
  assert.deepEqual(measured, box);
});

test("a fully transparent asset yields no ink box rather than a zero-sized crop", () => {
  assert.equal(inkBoxFromAlpha(Buffer.alloc(64 * 64, 0), 64, 64), null);
});

test("ink boxes are clamped to the asset canvas so a stale box cannot escape it", () => {
  // The borderless box against the smaller numbered-style canvas: this is the
  // exact combination that produced the -22 failure.
  assert.equal(safeInkBox(OA4_INK_BOX, { width: 468, height: 144 }).width <= 468, true);
  assert.equal(safeInkBox({ x: 500, y: 0, width: 100, height: 10 }, { width: 468, height: 144 }), null);
  assert.equal(safeInkBox({ x: 0, y: 0, width: 0, height: 0 }, { width: 468, height: 144 }), null);
});

test("measured ink boxes are cached by content hash and measured only once", async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ink-cache-"));
  let calls = 0;
  const measure = async () => { calls++; return { x: 24, y: 45, width: 422, height: 54, canvas: { width: 468, height: 144 } }; };
  const first = new InkBoxCache({ cacheRoot, measure });
  const entry = { path: "pic_watermark_oa6_1.png", sha256: "ABC123" };
  assert.equal((await first.resolve(entry)).width, 422);
  await first.resolve(entry);
  assert.equal(calls, 1, "second lookup must hit the cache");
  // A fresh instance reads the on-disk cache, so restarts do not re-probe.
  const second = new InkBoxCache({ cacheRoot, measure });
  assert.equal((await second.resolve(entry)).width, 422);
  assert.equal(calls, 1, "disk cache must survive a new registry instance");
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

test("concurrent requests for the same badge share a single measurement", async () => {
  let calls = 0;
  const measure = async () => { calls++; return { x: 3, y: 108, width: 774, height: 72, canvas: { width: 780, height: 288 } }; };
  const cache = new InkBoxCache({ cacheRoot: null, measure });
  const entry = { path: "pic_watermark_oa4_borderless.png", sha256: "DEF456" };
  await Promise.all([cache.resolve(entry), cache.resolve(entry), cache.resolve(entry)]);
  assert.equal(calls, 1);
});

function build(inkBox, canvasSize) {
  return buildFilterGraph({
    graph: createEffectGraph({
      overlays: [{ kind: "image", path: "badge.png", enabled: true, scale: 0.195, opacity: 1, inkBox, canvasSize }]
    }),
    lutRegistry: { get: () => null },
    styleRegistry: null,
    cacheRoot: "unused"
  });
}

test("non-borderless styles build a crop that stays inside their own canvas", async () => {
  // 468x144 numbered style: the previously hardcoded 774x72 crop is impossible here.
  const built = await build({ x: 35, y: 47, width: 398, height: 52 }, { width: 468, height: 144 });
  const crop = /crop=(\d+):(\d+):(\d+):(\d+)/.exec(built.filterGraph);
  assert.ok(crop, "overlay chain must contain a crop");
  const [, w, h, x, y] = crop.map(Number);
  assert.equal(w + x <= 468, true, "crop width must fit the canvas");
  assert.equal(h + y <= 144, true, "crop height must fit the canvas");
  assert.deepEqual([w, h, x, y], [398, 52, 35, 47]);
});

test("an out-of-bounds ink box is rejected instead of emitting a failing graph", async () => {
  await assert.rejects(() => build({ x: 900, y: 0, width: 774, height: 72 }, { width: 468, height: 144 }), /ink box is invalid/i);
});

test("glyph aspect ratio is preserved per asset so visual size stays consistent", async () => {
  // The three shipped assets have different glyph aspect ratios (7.65, 7.81,
  // 10.75). Height must follow each asset's own ratio, not a shared constant.
  for (const [ink, canvas, aspect] of [
    [{ x: 35, y: 47, width: 398, height: 52 }, { width: 468, height: 144 }, 398 / 52],
    [{ x: 24, y: 45, width: 422, height: 54 }, { width: 468, height: 144 }, 422 / 54],
    [{ x: 3, y: 108, width: 774, height: 72 }, { width: 780, height: 288 }, 774 / 72]
  ]) {
    const built = await build(ink, canvas);
    assert.ok(built.filterGraph.includes("scale2ref"), "overlay must be sized against the video");
    // Height is stated as iw*(scale*inkAspect); recover that coefficient and
    // confirm it tracks this asset's own glyph ratio rather than a constant.
    const h = /:h=round\(iw\*([\d.]+)\/2\)\*2/.exec(built.filterGraph);
    assert.ok(h, "height must be an explicit expression, not -1");
    assert.ok(Math.abs(0.195 / Number(h[1]) - aspect) / aspect < 0.02, "height must follow the asset glyph ratio");
  }
});
