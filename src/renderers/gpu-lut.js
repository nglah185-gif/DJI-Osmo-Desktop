"use strict";

// GPU 3D LUT through ffmpeg's libplacebo filter (Vulkan).
//
// The Rec.709 transform is the single largest cost in a D-Log export: measured
// at 59% of a 4K export (63.2s with the LUT against 25.6s without it, same
// decode and same encode). Moving it to the GPU measured 1.78x on the same clip
// (41.7s -> 23.5s), and the GPU's LUT math matches the CPU's exactly: the same
// RGB pixels through both engines differ by MAE 0.49, max channel error 1.
//
// libplacebo only exists in ffmpeg's "full" builds, so this is a capability
// that has to be probed rather than assumed. When the running ffmpeg lacks it,
// or Vulkan refuses to start, the caller falls back to the CPU lut3d stage and
// says so once instead of failing the export.

const GPU_FILTER = "libplacebo";

// 2 = PL_LUT_NORMALIZED. The .cube domain is 0..1 and the frame is mapped onto
// that domain. The filter's default (auto) guesses wrong for these files: it
// produced MAE 14 against the CPU result, while normalized is MAE 0.49.
const GPU_LUT_TYPE = 2;

function gpuLutFilter(lutPath) {
  const value = String(lutPath || "").replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  return GPU_FILTER + "=lut='" + value + "':lut_type=" + GPU_LUT_TYPE;
}

// The filter list is one line per filter; the name is enough to know the build
// carries the feature. Whether Vulkan then initializes is answered by the first
// real export, which can fall back.
function hasGpuLutFilter(filterListText) {
  return String(filterListText || "").includes(GPU_FILTER);
}

// Failures that mean "this build or this GPU cannot do it", as opposed to a bad
// filter graph. Only these should trigger the CPU retry.
function isGpuLutFailure(stderr) {
  return /libplacebo|vulkan|VkResult|pl_gpu|pl_vulkan|Failed (?:creating|importing) Vulkan/i.test(String(stderr || ""));
}

class GpuLutSupport {
  constructor({ ffmpegPath = "ffmpeg", runFfmpeg = null } = {}) {
    this.ffmpegPath = ffmpegPath;
    this.runFfmpeg = runFfmpeg;
    this.state = "unknown"; // unknown | available | unavailable | disabled
    this.pending = null;
  }

  // Cached: the answer cannot change while the process runs, and probing costs
  // a process spawn.
  async available() {
    if (this.state === "available") return true;
    if (this.state === "unavailable" || this.state === "disabled") return false;
    if (!this.pending) {
      this.pending = (async () => {
        if (typeof this.runFfmpeg !== "function") { this.state = "unavailable"; return false; }
        try {
          const result = await this.runFfmpeg(this.ffmpegPath, ["-hide_banner", "-filters"]);
          const listed = result && Number(result.code) === 0 && hasGpuLutFilter(result.stdout);
          this.state = listed ? "available" : "unavailable";
          return listed;
        } catch {
          this.state = "unavailable";
          return false;
        }
      })();
    }
    return this.pending;
  }

  // Called after a real export fails on libplacebo/Vulkan.
  disable() {
    this.state = "disabled";
    this.pending = null;
  }
}

module.exports = { GPU_FILTER, GPU_LUT_TYPE, gpuLutFilter, hasGpuLutFilter, isGpuLutFailure, GpuLutSupport };
