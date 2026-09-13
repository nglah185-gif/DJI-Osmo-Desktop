const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildFilterGraph } = require("./filter-graph-builder");
const { EncoderSelector, encoderArgs, encoderPixelFormat, hardwareDecodeArgs, isHardwareEncoderFailure } = require("./encoder-selection");
const { planExport, planAudio, PASSTHROUGH } = require("./export-plan");
const { probeSourceStreams } = require("./source-probe");
const { GpuLutSupport, isGpuLutFailure } = require("./gpu-lut");

// Each capability probe gets a hard deadline. A one-frame encode takes well
// under a second on any working driver, so anything near this is a wedged
// process, not a slow one.
const PROBE_TIMEOUT_MS = 5000;

class FfmpegExportRenderer {
  constructor(options = {}) {
    this.ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
    this.cacheRoot = options.cacheRoot;
    this.spawnProcess = options.spawnProcess || null;
    this.platform = options.platform || process.platform;
    this.encoderSelector = options.encoderSelector || new EncoderSelector({
      ffmpegPath: this.ffmpegPath,
      platform: this.platform,
      preferHardware: options.preferHardware !== false,
      runFfmpeg: (command, args) => run(command, args, { spawnProcess: this.spawnProcess, timeoutMs: Number(options.probeTimeoutMs) || PROBE_TIMEOUT_MS })
    });
    // GPU LUT is a capability, not a setting: the running ffmpeg may not carry
    // libplacebo and the GPU may still refuse Vulkan. Probe once, cache, and
    // fall back to the CPU stage on the first real failure.
    this.gpuLut = options.gpuLut || new GpuLutSupport({
      ffmpegPath: this.ffmpegPath,
      runFfmpeg: (command, args) => run(command, args, { spawnProcess: this.spawnProcess, timeoutMs: Number(options.probeTimeoutMs) || PROBE_TIMEOUT_MS })
    });
  }
  async render({ inputPath, outputPath, graph, lutRegistry, styleRegistry, durationSeconds = null, timestampSeconds = null, clip = null, onProgress = null, signal = null }) {
    if (!inputPath || !outputPath) throw new Error("Export input and output paths are required");
    if (path.resolve(inputPath) === path.resolve(outputPath)) throw new Error("Export output must be different from the source file");
    const sourceIn = clip ? Number(clip.sourceInUs || 0) / 1000000 : timestampSeconds;
    const sourceDuration = clip ? (Number(clip.sourceOutUs) - Number(clip.sourceInUs)) / 1000000 : durationSeconds;
    const requestedSpeed = clip ? Number(clip.playbackRate ?? 1) : 1;
    if (!Number.isFinite(requestedSpeed) || requestedSpeed <= 0) throw new Error("Export playback rate must be greater than zero");
    const speed = requestedSpeed;
    if (sourceDuration !== null && sourceDuration !== undefined && !(sourceDuration > 0)) throw new Error("Export clip duration must be greater than zero");
    const requestedVolume = clip ? Number(clip.volume ?? 1) : 1;
    const volume = Number.isFinite(requestedVolume) ? Math.max(0, requestedVolume) : 1;
    const muted = !!(clip && (clip.muted || volume === 0));
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const previewSize = (graph && graph.previewSize) || {};

    // Decide before compiling anything whether this export has to touch pixels.
    // An export that changes nothing about the picture is a remux, and a remux
    // runs at the speed of the drive rather than the speed of x264 -- measured
    // 16s against 296s on the 4K source, which is the difference between
    // saturating the camera link and leaving it idle.
    const probe = await probeSourceStreams({ inputPath, ffmpegPath: this.ffmpegPath, spawnProcess: this.spawnProcess });
    // A graph with a looped image input -- the watermark overlay, and the HALD
    // technical transform -- has no natural end. Without an output duration
    // ffmpeg loops that still forever: a batch export (no clip, so no duration
    // from the caller) wrote a 457 MB file from a 5 MB clip and would never have
    // stopped. The probe's duration is the file's own length, so it is the
    // correct bound when the caller gave none.
    const encodeDuration = resolveEncodeDuration({ sourceDuration, probeDuration: probe.durationSeconds });
    const outputDuration = encodeDuration !== null && encodeDuration !== undefined ? encodeDuration / speed : null;
    const progressDuration = resolveProgressDuration({ outputDuration, probeDuration: probe.durationSeconds, speed });
    const plan = planExport({ graph, clip, previewSize: graph && graph.previewSize });
    const audioPlan = planAudio({ clip, sourceCodec: probe.audioCodec });
    const canCopyVideo = plan.mode === PASSTHROUGH && probe.videoCopyable;

    if (canCopyVideo) {
      const copyArgs = buildCopyArgs({
        inputPath, outputPath, sourceIn, sourceDuration: encodeDuration,
        audioMode: probe.hasAudio ? audioPlan.mode : "drop", volume,
        videoCodec: probe.videoCodec
      });
      const copyResult = await run(this.ffmpegPath, copyArgs, { onProgress, durationSeconds: progressDuration, signal, spawnProcess: this.spawnProcess });
      if (copyResult.aborted) {
        await fs.rm(outputPath, { force: true }).catch(() => {});
        throw new Error("Export canceled");
      }
      if (copyResult.code === 0) {
        return { outputPath, filterGraph: null, generatedLuts: [], elapsedMs: copyResult.elapsedMs, encoder: "copy", hardwareEncoder: false, mode: PASSTHROUGH, planReasons: [], audioMode: probe.hasAudio ? audioPlan.mode : "drop" };
      }
      // A copy can fail on a container or bitstream quirk the probe cannot see.
      // Fall through to a real encode rather than failing the export: slow but
      // correct beats fast and broken.
      await fs.rm(outputPath, { force: true }).catch(() => {});
    }

    // Width and height come from the probe, not from previewSize. previewSize is
    // only set on preview renders, so on a real export it was always undefined
    // and the software thread cap that bounds x264's 3.2 GB peak never applied.
    const width = probe.width || previewSize.width || null;
    const height = probe.height || previewSize.height || null;
    // Built through a function because a libplacebo failure has to be retried on
    // the CPU, which means rebuilding every stage that follows the LUT.
    const buildCompiled = lutEngine => buildFilterGraph({
      graph, lutRegistry, styleRegistry, cacheRoot: this.cacheRoot,
      // Speed is applied as part of the graph rather than string-patched into it
      // afterwards, so a change to the graph's first filter cannot silently drop
      // the setpts and export at the wrong speed.
      inputPrefix: speed !== 1 ? "setpts=PTS/" + speed.toFixed(3) + "," : "",
      outputFormat: encoderPixelFormat(),
      lutEngine
    });
    // Only a technical color transform has a GPU path, so a graph without one
    // must not pay for -- or depend on -- the capability probe.
    const profile = graph && graph.colorTransform && graph.colorTransform.enabled ? graph.colorTransform.colorProfile : null;
    const wantsLut = !!(profile && profile.technicalTransformId);
    let lutEngine = wantsLut && (await this.gpuLut.available()) ? "gpu" : "cpu";
    let compiled = await buildCompiled(lutEngine);
    const buildArgs = encoder => buildExportArgs({
      encoder, inputPath, outputPath, filterGraph: compiled.filterGraph, inputArgs: compiled.inputArgs,
      sourceIn, sourceDuration: encodeDuration, speed, muted, volume,
      width, height, platform: this.platform,
      audioMode: probe.hasAudio ? audioPlan.mode : "drop"
    });
    const hardwareEncoder = await this.encoderSelector.select();
    let encoder = hardwareEncoder;
    let result = await run(this.ffmpegPath, buildArgs(encoder), { onProgress, durationSeconds: progressDuration, signal, spawnProcess: this.spawnProcess });
    // libplacebo can be listed by the build and still refuse to run here (no
    // Vulkan device, driver too old, filter graph mismatch). Rebuild without it
    // and retry rather than failing an export the CPU can finish.
    if (lutEngine === "gpu" && !result.aborted && result.code !== 0 && isGpuLutFailure(result.stderr)) {
      this.gpuLut.disable();
      lutEngine = "cpu";
      compiled = await buildCompiled(lutEngine);
      await fs.rm(outputPath, { force: true }).catch(() => {});
      result = await run(this.ffmpegPath, buildArgs(encoder), { onProgress, durationSeconds: progressDuration, signal, spawnProcess: this.spawnProcess });
    }
    // A hardware encoder that probed successfully can still fail at export time:
    // NVENC on consumer cards caps concurrent sessions, and a driver can be
    // updated mid-session. Retry once in software so the export completes
    // instead of surfacing a GPU error the user cannot act on. Not retried when
    // canceled, and not retried for ordinary failures like a bad filter graph.
    if (encoder && !result.aborted && result.code !== 0 && isHardwareEncoderFailure(result.stderr)) {
      this.encoderSelector.disableHardware();
      encoder = null;
      await fs.rm(outputPath, { force: true }).catch(() => {});
      result = await run(this.ffmpegPath, buildArgs(null), { onProgress, durationSeconds: progressDuration, signal, spawnProcess: this.spawnProcess });
    }
    if (result.aborted) {
      await fs.rm(outputPath, { force: true }).catch(() => {});
      throw new Error("Export canceled");
    }
    if (result.code !== 0) {
      // ffmpeg may leave a partial MP4 after an encoder or disk failure. Keep
      // the media library from indexing that unusable file on the next scan.
      await fs.rm(outputPath, { force: true }).catch(() => {});
      throw new Error("Export failed: " + result.stderr);
    }
    return { outputPath, filterGraph: compiled.filterGraph, generatedLuts: compiled.generatedLuts, elapsedMs: result.elapsedMs, encoder: encoder || "libx264", hardwareEncoder: !!encoder, mode: "transcode", lutEngine, planReasons: plan.reasons, audioMode: probe.hasAudio ? audioPlan.mode : "drop" };
  }
}

// Stream copy path. No -filter_complex, no encoder, no decode: ffmpeg reads
// packets and writes them into a new container.
//
// -ss goes BEFORE -i on purpose. That makes it an input seek, which jumps to the
// nearest preceding keyframe instead of decoding and discarding everything up to
// the cut. On this camera's footage keyframes land every 0.5s, so the cost is at
// most half a second of extra lead-in, against minutes saved.
function buildCopyArgs({ inputPath, outputPath, sourceIn, sourceDuration, audioMode = "copy", volume = 1, videoCodec = null }) {
  const args = ["-y", "-v", "error", "-progress", "pipe:2", "-nostats"];
  if (sourceIn !== null && sourceIn !== undefined && Number(sourceIn) > 0) args.push("-ss", String(sourceIn));
  args.push("-i", inputPath, "-map", "0:v:0");
  if (audioMode !== "drop") args.push("-map", "0:a?");
  // Measured: without this, both the copy and the transcode path drop the
  // camera's creation_time and the per-stream timecode tag, and stamp
  // encoder=Lavf... instead of the original. For a media tool that is data loss
  // -- creation_time is how the user finds out when a clip was shot. Explicitly
  // mapping input metadata preserves creation_time, timecode, language and
  // handler_name; ffmpeg does not carry them over on its own here.
  args.push("-map_metadata", "0");
  args.push("-c:v", "copy");
  if (audioMode === "copy") args.push("-c:a", "copy");
  else if (audioMode === "encode") {
    args.push("-c:a", "aac", "-b:a", "192k");
    if (Number(volume) !== 1) args.push("-af", "volume=" + Number(volume).toFixed(4));
  } else args.push("-an");
  // HEVC in MP4 must be tagged hvc1 or QuickTime and many hardware players
  // reject the file even though ffmpeg wrote it happily. The tag is codec
  // specific: applying it to H.264 would mislabel the stream, so it is only
  // added when the source really is HEVC.
  if (String(videoCodec || "").toLowerCase() === "hevc") args.push("-tag:v", "hvc1");
  // Input seeking can leave the first packet at a negative timestamp relative to
  // the new start. Shifting to zero keeps players from showing a frozen frame or
  // desynced audio at the head of a trimmed copy.
  args.push("-movflags", "+faststart", "-avoid_negative_ts", "make_zero");
  if (sourceDuration !== null && sourceDuration !== undefined) args.push("-t", String(sourceDuration));
  args.push(outputPath);
  return args;
}

function buildExportArgs({ encoder, inputPath, outputPath, filterGraph, inputArgs = [], sourceIn, sourceDuration, speed, muted, volume, width, height, platform = process.platform, audioMode = "encode" }) {
  const args = ["-y", "-v", "error", "-progress", "pipe:2", "-nostats"];
  // -hwaccel is an input option: it has to precede the -i it applies to, and it
  // applies only to the next input, so it goes here rather than with inputArgs
  // (which carries extra -i pairs for LUT and overlay images -- still images
  // that have nothing to decode on a GPU).
  args.push(...hardwareDecodeArgs({ encoder, platform }));
  if (sourceIn !== null && sourceIn !== undefined) args.push("-ss", String(sourceIn));
  args.push("-i", inputPath, ...inputArgs, "-filter_complex", filterGraph, "-map", "[outv]");
  if (!muted && audioMode !== "drop") args.push("-map", "0:a?");
  // See buildCopyArgs: without this the transcode drops creation_time and the
  // stream timecode tag. A filtered stream carries no metadata of its own, so
  // the source's has to be mapped explicitly.
  args.push("-map_metadata", "0");
  args.push(...encoderArgs(encoder, { width, height }));
  // Audio is copied when nothing asked for it to change. Re-encoding untouched
  // AAC costs a full decode/encode pass and loses quality for no reason.
  if (muted || audioMode === "drop") args.push("-an");
  else if (audioMode === "copy") args.push("-c:a", "copy");
  else {
    args.push("-c:a", "aac", "-b:a", "192k");
    const audioFilters = [];
    if (speed !== 1) audioFilters.push(...audioTempoFilters(speed));
    if (volume !== 1) audioFilters.push("volume=" + volume.toFixed(4));
    if (audioFilters.length) args.push("-af", audioFilters.join(","));
  }
  args.push("-movflags", "+faststart");
  if (sourceDuration !== null && sourceDuration !== undefined) args.push("-t", String(sourceDuration / speed));
  args.push(outputPath);
  return args;
}

// ffmpeg's atempo filter rejects any single tempo factor outside its supported
// range, and it rejects the WHOLE command rather than clamping. Verified on the
// bundled 9.0.1 build, whose range is [0.5, 100]:
//
//   atempo=4.000000   -> ok
//   atempo=0.250000   -> "Value 0.250000 for parameter 'tempo' out of range
//                         [0.5 - 100]" -> export failed
//
// The editor allows playback rates below 0.5x for slow motion, and the export
// passed that number straight through, so a 0.25x export failed outright. Chain
// short stages instead so any rate the editor accepts produces valid filters.
// Stages stay within [0.5, 2] rather than the wider range this build happens to
// allow, because that bound is the one every ffmpeg release agrees on.
const ATEMPO_MIN = 0.5;
const ATEMPO_MAX = 2;
const ATEMPO_MAX_STAGES = 32;

function audioTempoFilters(playbackRate) {
  let value = Number(playbackRate);
  if (!Number.isFinite(value) || value <= 0 || Math.abs(value - 1) < 1e-9) return [];
  const filters = [];
  while (value < ATEMPO_MIN && filters.length < ATEMPO_MAX_STAGES - 1) {
    filters.push("atempo=" + ATEMPO_MIN);
    value /= ATEMPO_MIN;
  }
  while (value > ATEMPO_MAX && filters.length < ATEMPO_MAX_STAGES - 1) {
    filters.push("atempo=" + ATEMPO_MAX);
    value /= ATEMPO_MAX;
  }
  // A hostile value such as 1e-300 must not emit an unbounded filter chain; the
  // final stage is clamped into range and absorbs whatever is left.
  value = Math.max(ATEMPO_MIN, Math.min(ATEMPO_MAX, value));
  if (Math.abs(value - 1) >= 1e-9) filters.push("atempo=" + value.toFixed(6));
  return filters;
}
function progressPercent(outTimeUs, durationSeconds) {
  const durationUs = Number(durationSeconds) * 1000000;
  if (!(durationUs > 0)) return null;
  return Math.max(0, Math.min(100, Math.round(Number(outTimeUs) / durationUs * 100)));
}
// The clock the progress bar is measured against. A single export gets its
// duration from the clip; a batch export has no clip and passes none, so without
// this fallback the render loop emitted no progress at all and the bar sat at 0%
// until it jumped to done. The probe already read the real length, so use it.
// Only the progress clock uses this -- the -t cut still comes from the caller's
// duration, so a guessed length can never truncate a file.
function resolveProgressDuration({ outputDuration = null, probeDuration = null, speed = 1 } = {}) {
  if (outputDuration !== null && outputDuration !== undefined) return outputDuration;
  const probed = Number(probeDuration);
  return probed > 0 ? probed / speed : null;
}
// The duration the output is cut to. A caller that supplies one (a trimmed clip,
// or a preview render) is authoritative. A batch export supplies none, and the
// graph may contain a looped still (watermark, HALD LUT) that would otherwise
// keep ffmpeg producing frames forever; the probe's duration is the source's own
// length, so it bounds the output without changing what is exported.
function resolveEncodeDuration({ sourceDuration = null, probeDuration = null } = {}) {
  if (sourceDuration !== null && sourceDuration !== undefined) return sourceDuration;
  const probed = Number(probeDuration);
  return probed > 0 ? probed : null;
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const spawnProcess = options.spawnProcess || spawn;
    const child = spawnProcess(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let pending = "";
    let lastPct = -1;
    let aborted = false;
    let settled = false;
    let timer = null;
    // A probe must never be able to hang an export. ffmpeg can stall before it
    // prints a single byte when a GPU driver is wedged, and with no deadline the
    // export would wait on it forever. Real exports pass no timeout, because a
    // long encode is legitimate; only the capability probes set one.
    const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
    const abort = () => { aborted = true; try { child.kill("SIGKILL"); } catch {} };
    const detach = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (options.signal) options.signal.removeEventListener("abort", abort);
    };
    const settle = result => {
      if (settled) return;
      settled = true;
      detach();
      resolve({ ...result, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString(), elapsedMs: Date.now() - started });
    };
    // Listeners are attached BEFORE the abort handling below. A child can emit
    // close synchronously from kill() -- real short-lived processes and test
    // doubles both do -- so handling a pre-aborted signal first would fire the
    // kill before anything was listening and leave the promise pending forever.
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => {
      stderr.push(chunk);
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/.exec(line.trim());
        if (!match) continue;
        const pct = progressPercent(match[1], options.durationSeconds);
        if (pct !== null && pct !== lastPct) { lastPct = pct; if (typeof options.onProgress === "function") options.onProgress(pct); }
      }
    });
    child.on("error", error => {
      if (aborted) { settle({ code: null, aborted: true }); return; }
      if (settled) return;
      detach();
      settled = true;
      reject(error);
    });
    child.on("close", code => {
      if (!aborted && code === 0 && typeof options.onProgress === "function" && lastPct !== 100) options.onProgress(100);
      settle({ code, aborted, timedOut: false });
    });
    if (options.signal) { if (options.signal.aborted) abort(); else options.signal.addEventListener("abort", abort, { once: true }); }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        // A killed child does not always emit close. Resolve on the deadline so
        // the caller is never left waiting on a process that will not report.
        settle({ code: null, aborted: false, timedOut: true });
      }, timeoutMs);
    }
  });
}
module.exports = { FfmpegExportRenderer, buildExportArgs, buildCopyArgs, encoderPixelFormat, audioTempoFilters, progressPercent, resolveProgressDuration, resolveEncodeDuration, run };
