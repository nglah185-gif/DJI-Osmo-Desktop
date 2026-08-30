const { spawn } = require("node:child_process");
const { buildFilterGraph } = require("./filter-graph-builder");
const { previewFitFilter } = require("./preview-fit");

class FfmpegFrameRenderer {
  constructor(options = {}) { this.ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg"; this.cacheRoot = options.cacheRoot; }
  async render({ inputPath, timestampSeconds, graph, lutRegistry, styleRegistry, width = null, height = null, hardwareDecode = true }) {
    const cpuBefore = process.cpuUsage();
    const previewGraph = { ...(graph || {}), previewSize: { width: width || 640, height: height || 360 } };
    const fit = previewFitFilter(width, height);
    // rgb24 output and the fit filter are requested from the builder rather than
    // spliced into the finished graph string, so this cannot quietly stop
    // applying if the builder's final stage changes.
    const compiled = await buildFilterGraph({ graph: previewGraph, lutRegistry, styleRegistry, cacheRoot: this.cacheRoot, outputFormat: "rgb24", outputSuffix: fit });
    const decode = hardwareDecode && process.platform === "win32" ? ["-hwaccel", "auto"] : []; const result = await run(this.ffmpegPath, ["-v", "error", ...decode, "-ss", String(timestampSeconds), "-i", inputPath, ...compiled.inputArgs, "-filter_complex", compiled.filterGraph, "-map", "[outv]", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"]);
    if (result.code !== 0) throw new Error("Preview frame render failed: " + result.stderr);
    const cpu = process.cpuUsage(cpuBefore);
    return { png: result.stdout, elapsedMs: result.elapsedMs, decodeMode: decode.length ? "AUTO_HARDWARE_OR_SOFTWARE" : "SOFTWARE", fps: result.elapsedMs > 0 ? 1000 / result.elapsedMs : 0, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, rssMb: process.memoryUsage().rss / 1024 / 1024, gpuTelemetry: "UNAVAILABLE", width, height, filterGraph: compiled.filterGraph, generatedLuts: compiled.generatedLuts };
  }
}
function run(command, args) { return new Promise((resolve, reject) => { const started = Date.now(); const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); const stdout = []; const stderr = []; child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk)); child.on("error", reject); child.on("close", code => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString(), elapsedMs: Date.now() - started })); }); }
module.exports = { FfmpegFrameRenderer };
