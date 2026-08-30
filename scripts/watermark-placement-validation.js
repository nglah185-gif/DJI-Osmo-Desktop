// Measures where the watermark ink actually lands, per resolution, by rendering
// a real frame through the production filter graph and scanning the result.
//
// The graph is shared by export, still rendering and live preview, so a single
// measurement per resolution covers all three. Failure means the badge would
// drift or change size between formats.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { buildFilterGraph } = require("../src/renderers/filter-graph-builder");
const { INK_CENTER_Y_RATIO, INK_WIDTH_RATIO } = require("../src/watermark/watermark-position");

const BIN = path.join(__dirname, "..", "release", "DJI-Osmo-Desktop-0.1.0-win-x64-portable", "resources", "bin");
const FFMPEG = path.join(BIN, "ffmpeg.exe");
const BADGE = process.argv[2] || path.join(__dirname, "..", "..", "watermark", "pic_watermark_oa4_borderless.png");

// Landscape video, portrait video, 4:3 stills, 16:9 stills, and a small preview
// canvas. Covers the Action 4 capture modes plus the preview surface size.
const CASES = [
  { label: "video 4K 16:9", width: 3840, height: 2160 },
  { label: "video 1080p 16:9", width: 1920, height: 1080 },
  { label: "video portrait 9:16", width: 1080, height: 1920 },
  { label: "photo 4:3", width: 4000, height: 3000 },
  { label: "photo 16:9", width: 4000, height: 2250 },
  { label: "preview canvas", width: 640, height: 360 }
];

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let err = "";
    child.stderr.on("data", d => { err += d.toString(); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(err.slice(-2000))));
  });
}

// Scans a raw grayscale frame for the bounding box of non-black pixels. The
// synthetic source is pure black, so any ink is the badge.
function inkBox(buffer, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (buffer[y * width + x] > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function measure(testCase, tmp) {
  const graph = {
    sourceTransform: { enabled: true },
    displayGeometry: { enabled: false },
    colorTransform: { enabled: false },
    styleStack: [],
    adjustments: [],
    overlays: [{ enabled: true, kind: "image", path: BADGE, scale: INK_WIDTH_RATIO, opacity: 1 }]
  };
  const built = await buildFilterGraph({ graph, lutRegistry: { get: () => null }, styleRegistry: null, cacheRoot: null });
  const out = path.join(tmp, "frame-" + testCase.width + "x" + testCase.height + ".gray");
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=" + testCase.width + "x" + testCase.height + ":d=1",
    ...built.inputArgs,
    "-filter_complex", built.filterGraph,
    "-map", "[outv]", "-frames:v", "1",
    "-pix_fmt", "gray", "-f", "rawvideo", "-y", out
  ]);
  const box = inkBox(fs.readFileSync(out), testCase.width, testCase.height);
  fs.unlinkSync(out);
  if (!box) return { ...testCase, error: "no ink found" };
  return {
    ...testCase,
    box,
    widthRatio: box.width / testCase.width,
    centerYRatio: (box.y + box.height / 2) / testCase.height,
    centerXRatio: (box.x + box.width / 2) / testCase.width,
    aspect: box.width / box.height
  };
}

(async () => {
  if (!fs.existsSync(FFMPEG)) throw new Error("ffmpeg not found at " + FFMPEG);
  if (!fs.existsSync(BADGE)) throw new Error("badge not found at " + BADGE);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wm-validate-"));
  const results = [];
  for (const testCase of CASES) results.push(await measure(testCase, tmp));
  fs.rmSync(tmp, { recursive: true, force: true });

  // Tolerances: 1% of frame width for size, 1% of frame height for the line,
  // 0.5% for centring. Anything looser would be visible as drift between
  // formats; anything tighter would trip on even/odd rounding in the scaler.
  let failed = 0;
  for (const r of results) {
    if (r.error) { console.log("FAIL " + r.label + " :: " + r.error); failed++; continue; }
    const dW = Math.abs(r.widthRatio - INK_WIDTH_RATIO);
    const dY = Math.abs(r.centerYRatio - INK_CENTER_Y_RATIO);
    const dX = Math.abs(r.centerXRatio - 0.5);
    const dA = Math.abs(r.aspect - 774 / 72) / (774 / 72);
    const bad = dW > 0.01 || dY > 0.01 || dX > 0.005 || dA > 0.08;
    if (bad) failed++;
    console.log(
      (bad ? "FAIL " : "ok   ") + r.label.padEnd(18)
      + " ink=" + r.box.width + "x" + r.box.height + "@" + r.box.x + "," + r.box.y
      + "  width=" + r.widthRatio.toFixed(4) + " (target " + INK_WIDTH_RATIO + ")"
      + "  centerY=" + r.centerYRatio.toFixed(4) + " (target " + INK_CENTER_Y_RATIO + ")"
      + "  centerX=" + r.centerXRatio.toFixed(4)
      + "  aspect=" + r.aspect.toFixed(2) + " (target 10.75)"
    );
  }
  console.log(failed ? "\n" + failed + " case(s) out of tolerance" : "\nall " + results.length + " cases within tolerance");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("ERR " + e.message); process.exit(1); });
