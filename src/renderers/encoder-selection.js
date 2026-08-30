"use strict";

// Encoder selection for export.
//
// Measured on a 4K 43s clip through the real export filter graph (lut3d +
// scale + format), same source file for every run:
//
//   libx264 medium, 12 threads   73.7s   peak RSS 3266 MB
//   libx264 medium,  4 threads   83.9s   peak RSS 2195 MB
//   h264_nvenc p4                45.8s   peak RSS 1338 MB
//
// Two results here are counter-intuitive and worth recording so they are not
// "optimized" back in later:
//
// 1. Removing the redundant `format=rgb24` stages changed nothing (73.7 ->
//    74.4s, peak RSS identical to the megabyte). The cost is not the pixel
//    format conversion, it is x264 itself.
// 2. Adding `-hwaccel cuda` made the export SLOWER (45.8 -> 54.9s). The filters
//    run on the CPU, so hardware-decoded frames have to be copied back out of
//    VRAM, and that round trip costs more than the decode saves.
//
// The memory blowup is x264's per-thread frame buffers scaling with frame size,
// which is why it only became visible on 4K footage.
//
// Re-measured later on a machine where NVENC is unavailable (GTX 1660 SUPER,
// driver NVENC API 13.0 against an ffmpeg build requiring 13.1, so both
// h264_nvenc and hevc_nvenc refuse to open; the CPU is an i5-12490F, an "F" part
// with no iGPU, so QSV cannot work either, and AMF needs an AMD card). Every
// candidate failed and every export silently ran on libx264. 4K60 HEVC, 43.6s,
// 2615 frames:
//
//   libx264 medium                      415.9s   0.10x realtime
//   h264_mf (MediaFoundation)           156.8s   0.28x
//   dxva2 decode + h264_mf              125.2s   0.35x
//
// Two things this changes about point 2 above. h264_mf reaches the same GPU
// without going through the NVENC API version check, so it is a usable hardware
// path on machines where nvenc is locked out. And hardware DECODE does pay off
// after all, but only with the right hwaccel: decode alone is 69.9s of that
// 156.8s, dxva2 cuts it to 20.4s and survives the copy back to system memory
// (128.3 -> 104.9s measured through the real filter graph), while cuda decode
// still loses (171.5s end to end). So dxva2 is enabled and cuda is not.
//
// Rejected, measured, do not retry:
//
// - Parallel segment encoding. 3 ways 125.8s (no gain), 4 ways dropped frames,
//   6 ways died with "Failed to transfer data to output frame: -12" (VRAM
//   exhaustion). The processes contend on the single GPU decoder; this is not a
//   core count problem.
// - lut3d interp=trilinear. Saves 10.4s (125.2 -> 114.8s) at SSIM 0.9894 /
//   PSNR 45.9 dB against tetrahedral. That stage is the D-Log M to Rec.709
//   conversion, so colour accuracy is the whole point of it. Not worth 8%.
// - Offloading the LUT to the GPU. This ffmpeg build has no lut3d_cuda and no
//   libplacebo, so the filter graph (~83s of the remaining 125s) is stuck on
//   the CPU and is now the dominant cost.

const SOFTWARE_ENCODER = "libx264";

// Every encoder here produces 8-bit H.264, so the pixel format an encoder wants
// at its input is always yuv420p. This is exported so the filter graph can end
// in exactly this format: the graph works internally in 10-bit to avoid banding
// through the LUT and eq stages, then converts down once. Without agreement
// here the graph converted to 10-bit and the encoder immediately converted back,
// paying for a full-frame conversion twice to reach the same result.
const ENCODER_PIXEL_FORMAT = "yuv420p";

function encoderPixelFormat() {
  return ENCODER_PIXEL_FORMAT;
}

// Hardware candidates per platform, in preference order. Every entry has to
// produce H.264 in MP4 so the output stays interchangeable with the software
// path.
// h264_mf is last on Windows deliberately. It is a MediaFoundation wrapper, so
// it is the broadest fallback -- it reaches whatever GPU Windows exposes without
// the vendor SDK version checks that lock out nvenc -- but the vendor encoders
// give finer quality control, so they stay ahead of it when they work.
const HARDWARE_CANDIDATES = {
  win32: ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf"],
  darwin: ["h264_videotoolbox"],
  linux: ["h264_nvenc", "h264_qsv"]
};

// CRF 18 is the established software quality target. The hardware constant
// quality scales are not the same scale as CRF, so these are mapped per encoder
// rather than reusing the number.
const HARDWARE_QUALITY = {
  h264_nvenc: ["-preset", "p4", "-cq", "21"],
  h264_qsv: ["-global_quality", "21"],
  h264_amf: ["-quality", "balanced", "-rc", "cqp", "-qp_i", "21", "-qp_p", "21"],
  h264_videotoolbox: ["-q:v", "55"],
  // MediaFoundation exposes a 0-100 quality scale where higher is better, the
  // opposite direction to CRF and CQ. 60 measured 369.8 MB against libx264
  // CRF 18's 397.3 MB on the same 4K source.
  h264_mf: ["-rate_control", "quality", "-quality", "60"]
};

// x264 memory scales with (threads x frame size). Left unbounded a 4K export
// peaked at 3.2 GB. Capping threads bounds that, at a real speed cost, so it is
// only applied above a frame size where the memory actually matters.
const THREAD_CAP_PIXEL_THRESHOLD = 3840 * 2160;
const SOFTWARE_THREAD_CAP = 8;

function softwareEncoderArgs(options = {}) {
  const args = ["-c:v", SOFTWARE_ENCODER, "-preset", "medium", "-crf", "18"];
  const cap = softwareThreadCap(options.width, options.height);
  if (cap) args.push("-threads", String(cap));
  args.push("-pix_fmt", ENCODER_PIXEL_FORMAT);
  return args;
}

function softwareThreadCap(width, height) {
  const pixels = Number(width) * Number(height);
  if (!Number.isFinite(pixels) || pixels <= 0) return 0;
  return pixels >= THREAD_CAP_PIXEL_THRESHOLD ? SOFTWARE_THREAD_CAP : 0;
}

function hardwareEncoderArgs(encoder) {
  const quality = HARDWARE_QUALITY[encoder];
  if (!quality) throw new Error("Unknown hardware encoder: " + encoder);
  return ["-c:v", encoder, ...quality, "-pix_fmt", ENCODER_PIXEL_FORMAT];
}

function encoderArgs(encoder, options = {}) {
  if (!encoder || encoder === SOFTWARE_ENCODER) return softwareEncoderArgs(options);
  return hardwareEncoderArgs(encoder);
}

// Hardware decode, as input options, and only where it was actually measured to
// win: dxva2 on Windows. cuda lost on this same footage (see the note at the top
// of this file), so this is an explicit allow-list rather than `-hwaccel auto`,
// which would pick cuda on an NVIDIA machine and give back the gain.
//
// Only applied when a hardware ENCODER was selected. The software path is the
// fallback that runs after hardware already failed once, and it is not worth
// introducing an untested variable into the run that has to succeed. ffmpeg
// falls back to software decode on its own if dxva2 cannot handle the stream, so
// this cannot fail an export that would otherwise have worked.
const HARDWARE_DECODE = { win32: "dxva2" };

function hardwareDecodeArgs({ encoder = null, platform = process.platform } = {}) {
  if (!encoder || encoder === SOFTWARE_ENCODER) return [];
  const accel = HARDWARE_DECODE[platform];
  return accel ? ["-hwaccel", accel] : [];
}

function hardwareCandidates(platform) {
  return HARDWARE_CANDIDATES[platform] || [];
}

// ffmpeg exiting non-zero is not by itself proof that the encoder is unusable:
// a bad filter graph or an unwritable destination fails the same way. Only
// treat failures that name the encoder or its driver as a reason to fall back,
// so a genuine user error is not silently retried and reported as a slow
// software export.
const ENCODER_FAILURE_PATTERNS = [
  /cannot load nvcuda/i,
  /no capable devices found/i,
  /no NVENC capable devices/i,
  /OpenEncodeSessionEx failed/i,
  /out of memory/i,
  /incompatible client key/i,
  /driver does not support/i,
  /Error initializing output stream.*(nvenc|qsv|amf|videotoolbox|mf)/i,
  /(nvenc|qsv|amf|videotoolbox).*(not (available|supported)|failed|error)/i,
  // MediaFoundation reports a missing or unusable transform rather than naming
  // the encoder, so it needs its own pattern to be recognised as a hardware
  // failure worth retrying in software.
  /MFTEnumEx/i,
  /Could not (create|initialize) the MF/i,
  /Unknown encoder/i,
  /Provided device doesn't support/i
];

function isHardwareEncoderFailure(stderr) {
  const text = String(stderr || "");
  if (!text) return false;
  return ENCODER_FAILURE_PATTERNS.some(pattern => pattern.test(text));
}

// A tiny real encode is the only trustworthy probe. `ffmpeg -encoders` lists
// what was compiled in, which on a Windows build includes NVENC on machines
// with no NVIDIA GPU at all, so it would route every export to an encoder that
// then fails at runtime.
async function probeHardwareEncoder({ ffmpegPath, runFfmpeg, platform = process.platform, candidates = null } = {}) {
  if (typeof runFfmpeg !== "function") throw new Error("probeHardwareEncoder requires a runFfmpeg function");
  const list = candidates || hardwareCandidates(platform);
  for (const encoder of list) {
    const args = [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "color=c=black:s=256x256:r=25:d=0.2",
      ...hardwareEncoderArgs(encoder),
      "-f", "null", "-"
    ];
    let result = null;
    try {
      result = await runFfmpeg(ffmpegPath, args);
    } catch {
      continue;
    }
    if (result && result.code === 0) return encoder;
  }
  return null;
}

// Probing spawns a process, so the result is cached per ffmpeg binary. Failures
// are cached too: a machine without a usable GPU should pay the probe cost once
// per session, not once per export.
class EncoderSelector {
  constructor(options = {}) {
    this.ffmpegPath = options.ffmpegPath || "ffmpeg";
    this.runFfmpeg = options.runFfmpeg;
    this.platform = options.platform || process.platform;
    this.preferHardware = options.preferHardware !== false;
    this.candidates = options.candidates || null;
    this._pending = null;
    this._resolved = undefined;
    this._disabled = false;
  }

  // Set once a hardware export has actually failed. NVENC on consumer cards has
  // a concurrent session limit, so an encoder that probed fine can still be
  // unavailable later; without this the next export would probe successfully
  // and fail again.
  disableHardware() {
    this._disabled = true;
    this._resolved = null;
    this._pending = null;
  }

  async select() {
    if (this._disabled || !this.preferHardware) return null;
    if (this._resolved !== undefined) return this._resolved;
    if (!this._pending) {
      this._pending = probeHardwareEncoder({
        ffmpegPath: this.ffmpegPath,
        runFfmpeg: this.runFfmpeg,
        platform: this.platform,
        candidates: this.candidates
      }).then(encoder => {
        this._resolved = encoder;
        this._pending = null;
        return encoder;
      }).catch(() => {
        this._resolved = null;
        this._pending = null;
        return null;
      });
    }
    return this._pending;
  }
}

module.exports = {
  SOFTWARE_ENCODER,
  ENCODER_PIXEL_FORMAT,
  encoderPixelFormat,
  HARDWARE_CANDIDATES,
  HARDWARE_QUALITY,
  HARDWARE_DECODE,
  hardwareDecodeArgs,
  SOFTWARE_THREAD_CAP,
  THREAD_CAP_PIXEL_THRESHOLD,
  softwareEncoderArgs,
  softwareThreadCap,
  hardwareEncoderArgs,
  encoderArgs,
  hardwareCandidates,
  isHardwareEncoderFailure,
  probeHardwareEncoder,
  EncoderSelector
};
