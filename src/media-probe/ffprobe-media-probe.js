const { spawn } = require("node:child_process");
const { parseNumber, parseRational, parseRotation, normalizeMetadata, UNKNOWN } = require("../shared/models");

class FfprobeMediaProbe {
  constructor(options = {}) {
    this.ffprobePath = options.ffprobePath || process.env.FFPROBE_PATH || "ffprobe";
    this.spawnImpl = options.spawnImpl || spawn;
    this.timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(1000, Number(options.timeoutMs)) : 15000;
  }

  probe(filePath) {
    return new Promise((resolve, reject) => {
      const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath];
      const child = this.spawnImpl(this.ffprobePath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        try { child.kill("SIGKILL"); } catch {}
        settled = true;
        reject(new Error("ffprobe timed out after " + this.timeoutMs + "ms for " + filePath));
      }, this.timeoutMs);
      const finish = callback => value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      child.stdout.on("data", chunk => { stdout += chunk.toString(); });
      child.stderr.on("data", chunk => { stderr += chunk.toString(); });
      child.on("error", finish(error => reject(new Error("Unable to start ffprobe: " + error.message))));
      child.on("close", finish((code) => {
        if (code !== 0) { reject(new Error("ffprobe failed for " + filePath + ": " + (stderr.trim() || "exit " + code))); return; }
        try { resolve(this.normalize(JSON.parse(stdout))); }
        catch (error) { reject(new Error("Invalid ffprobe JSON for " + filePath + ": " + error.message)); }
      }));
    });
  }

  normalize(raw) {
    const format = raw.format || {};
    const streams = Array.isArray(raw.streams) ? raw.streams : [];
    const video = streams.find(stream => stream.codec_type === "video") || {};
    const audio = streams.find(stream => stream.codec_type === "audio") || {};
    const formatTags = format.tags || {};
    const videoTags = video.tags || {};
    const tags = { ...formatTags, ...videoTags };
    const matrixSideData = Array.isArray(video.side_data_list) ? video.side_data_list.find(item => item.side_data_type === "Display Matrix") : null;
    const rotation = videoTags.rotate ?? (matrixSideData && matrixSideData.rotation);
    const audioFacts = { codec: audio.codec_name || UNKNOWN, profile: audio.profile || UNKNOWN, sampleRate: parseNumber(audio.sample_rate), channels: parseNumber(audio.channels), bitrate: parseNumber(audio.bit_rate), duration: parseNumber(audio.duration) };
    return {
      container: format.format_name || UNKNOWN,
      codec: video.codec_name || audio.codec_name || UNKNOWN,
      profile: video.profile || UNKNOWN,
      pixelFormat: video.pix_fmt || UNKNOWN,
      bitDepth: parseNumber(video.bits_per_raw_sample || video.bits_per_sample),
      width: parseNumber(video.width), height: parseNumber(video.height),
      fps: parseRational(video.avg_frame_rate || video.r_frame_rate),
      duration: parseNumber(video.duration || format.duration),
      bitrate: parseNumber(video.bit_rate || format.bit_rate),
      audio: audioFacts, sampleRate: audioFacts.sampleRate, channels: audioFacts.channels,
      rotation: parseRotation(rotation),
      displayMatrix: matrixSideData && matrixSideData.displaymatrix ? String(matrixSideData.displaymatrix) : UNKNOWN,
      color: { range: video.color_range || UNKNOWN, primaries: video.color_primaries || UNKNOWN, transfer: video.color_transfer || UNKNOWN, matrix: video.colorspace || UNKNOWN, chromaLocation: video.chroma_location || UNKNOWN },
      timecode: tags.timecode || UNKNOWN, creationTime: tags.creation_time || UNKNOWN,
      metadata: normalizeMetadata({ ...formatTags, ...videoTags })
    };
  }
}
module.exports = { FfprobeMediaProbe };
