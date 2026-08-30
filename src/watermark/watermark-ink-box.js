const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Watermark PNGs ship on a fixed canvas with generous transparent padding, and
// the padding differs per asset. Measured examples:
//   pic_watermark_oa4_borderless.png  780x288  ink 774x72 @ (3,108)   10.75:1
//   pic_watermark_oa4_1.png           468x144  ink 398x52 @ (35,47)    7.65:1
//   pic_watermark_oa6_1.png           468x144  ink 422x54 @ (24,45)    7.81:1
// A single hardcoded ink box therefore cannot serve every asset: applying the
// borderless 774x72 crop to a 468x144 asset makes ffmpeg fail the whole graph
// with "Invalid too big or non positive size" / -22, which took out preview and
// export for every style except borderless. Measure each asset instead.

const ALPHA_THRESHOLD = 8;

// Scan a gray8 alpha plane for the tight bounding box of non-transparent pixels.
function inkBoxFromAlpha(buffer, width, height, threshold = ALPHA_THRESHOLD) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (buffer[row + x] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function runProcess(command, args, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", chunk => out.push(chunk));
    child.stderr.on("data", chunk => err.push(chunk));
    child.on("error", reject);
    child.on("close", code => code === 0
      ? resolve(Buffer.concat(out))
      : reject(new Error(Buffer.concat(err).toString() || "exit " + code)));
  });
}

async function probeSize(assetPath, { ffprobePath = process.env.FFPROBE_PATH || "ffprobe", spawnProcess } = {}) {
  const raw = await runProcess(ffprobePath, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", assetPath
  ], spawnProcess);
  const [width, height] = String(raw).trim().split(",").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Could not read watermark dimensions: " + assetPath);
  }
  return { width, height };
}

// Extract the alpha plane as gray8 on stdout and scan it. Uses only the alpha
// channel, so fully opaque assets correctly report their whole canvas as ink.
async function measureInkBox(assetPath, options = {}) {
  const { ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg", spawnProcess } = options;
  const { width, height } = await probeSize(assetPath, options);
  const alpha = await runProcess(ffmpegPath, [
    "-v", "error", "-i", assetPath,
    "-vf", "format=rgba,alphaextract,format=gray",
    "-frames:v", "1", "-f", "rawvideo", "-"
  ], spawnProcess);
  if (alpha.length < width * height) {
    throw new Error("Short alpha plane for watermark: " + assetPath);
  }
  const box = inkBoxFromAlpha(alpha, width, height);
  // A fully transparent asset has no ink; fall back to the whole canvas rather
  // than emitting a zero-sized crop that would fail the filter graph. The canvas
  // travels with the box so downstream clamping can reject stale measurements.
  return { ...(box || { x: 0, y: 0, width, height }), canvas: { width, height } };
}

// Measuring every shipped watermark at startup would spawn hundreds of ffmpeg
// processes, so results are cached by content hash and measured lazily on first
// use. The hash key means a replaced asset is re-measured automatically.
class InkBoxCache {
  constructor({ cacheRoot, ffmpegPath, ffprobePath, spawnProcess, measure = measureInkBox } = {}) {
    this.cacheRoot = cacheRoot || null;
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.spawnProcess = spawnProcess;
    this.measure = measure;
    this.memory = new Map();
    this.pending = new Map();
  }
  filePathFor(sha256) {
    return this.cacheRoot ? path.join(this.cacheRoot, "ink-box-" + String(sha256).toUpperCase() + ".json") : null;
  }
  readDisk(sha256) {
    const file = this.filePathFor(sha256);
    if (!file || !fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return Number(parsed.width) > 0 && Number(parsed.height) > 0 ? parsed : null;
    } catch { return null; }
  }
  writeDisk(sha256, box) {
    const file = this.filePathFor(sha256);
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(box));
    } catch { /* cache is an optimisation; failure must not break preview */ }
  }
  get(sha256) {
    return this.memory.get(sha256) || this.readDisk(sha256) || null;
  }
  // Concurrent preview launches ask for the same badge at once; share one probe.
  async resolve({ path: assetPath, sha256 }) {
    const cached = this.get(sha256);
    if (cached) { this.memory.set(sha256, cached); return cached; }
    if (this.pending.has(sha256)) return this.pending.get(sha256);
    const task = this.measure(assetPath, {
      ffmpegPath: this.ffmpegPath, ffprobePath: this.ffprobePath, spawnProcess: this.spawnProcess
    }).then(box => {
      this.memory.set(sha256, box);
      this.writeDisk(sha256, box);
      return box;
    }).finally(() => { this.pending.delete(sha256); });
    this.pending.set(sha256, task);
    return task;
  }
}

// Synchronous canvas size straight from the PNG IHDR chunk (bytes 16..23).
// The filter graph must know the asset canvas even when no measured ink box is
// available, otherwise the out-of-bounds crop guard has nothing to clamp
// against. Spawning ffprobe is async and the graph builder is synchronous, and
// every shipped watermark is a PNG, so the 24-byte header read is enough.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngCanvasSize(assetPath) {
  let fd = null;
  try {
    fd = fs.openSync(assetPath, "r");
    const header = Buffer.alloc(24);
    if (fs.readSync(fd, header, 0, 24, 0) < 24) return null;
    if (!header.subarray(0, 8).equals(PNG_MAGIC)) return null;
    if (header.toString("latin1", 12, 16) !== "IHDR") return null;
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    if (!(width > 0) || !(height > 0)) return null;
    return { width, height };
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

module.exports = { measureInkBox, inkBoxFromAlpha, InkBoxCache, ALPHA_THRESHOLD, pngCanvasSize };
