"use strict";

// Read the source's stream layout before deciding how to export it.
//
// The passthrough path needs three facts that only the file can answer: the
// audio codec (copyable into MP4 or not), the video codec (copyable into MP4 or
// not), and the frame dimensions. Guessing any of them turns a fast export into
// a corrupt file -- copying HEVC into MP4 is fine, copying it into a container
// that rejects it is not, and the encoder's thread cap depends on frame size.
//
// This is a single short ffprobe. It costs ~40ms against the camera over USB,
// against an export that otherwise takes minutes, so it always runs rather than
// being conditional on the plan.

const { spawn } = require("node:child_process");

// Video codecs that are legal in an MP4 container and can therefore be stream
// copied. Deliberately a whitelist: an unlisted codec re-encodes, which is slow
// but always produces a playable file.
const MP4_VIDEO_CODECS = /^(h264|hevc|mpeg4|av1|vp9)$/i;

function ffprobePath(ffmpegPath) {
  // ffprobe ships beside ffmpeg. Deriving the path keeps a custom FFMPEG_PATH
  // working instead of falling back to a bare "ffprobe" that may not be on PATH.
  const value = String(ffmpegPath || "ffmpeg");
  const replaced = value.replace(/ffmpeg(\.exe)?$/i, match => (match.toLowerCase() === "ffmpeg.exe" ? "ffprobe.exe" : "ffprobe"));
  return replaced === value ? "ffprobe" : replaced;
}

async function probeSourceStreams({ inputPath, ffmpegPath = "ffmpeg", spawnProcess = null, runProbe = null } = {}) {
  if (!inputPath) throw new Error("probeSourceStreams requires an input path");
  const args = [
    "-v", "error",
    "-show_entries", "stream=index,codec_type,codec_name,width,height,r_frame_rate,bit_rate,nb_frames",
    "-show_entries", "format=duration,bit_rate",
    "-of", "json",
    inputPath
  ];
  let result = null;
  try {
    result = typeof runProbe === "function"
      ? await runProbe(ffprobePath(ffmpegPath), args)
      : await runOnce(ffprobePath(ffmpegPath), args, spawnProcess);
  } catch {
    // A missing or failing ffprobe must not block the export. An unknown layout
    // simply means no passthrough and no thread cap.
    return emptyProbe();
  }
  if (!result || result.code !== 0) return emptyProbe();
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    return emptyProbe();
  }
  return interpretProbe(parsed);
}

function interpretProbe(parsed) {
  const streams = Array.isArray(parsed && parsed.streams) ? parsed.streams : [];
  const video = streams.find(item => item && item.codec_type === "video") || null;
  const audio = streams.find(item => item && item.codec_type === "audio") || null;
  const format = (parsed && parsed.format) || {};
  const width = video ? Number(video.width) || null : null;
  const height = video ? Number(video.height) || null : null;
  return {
    videoCodec: video && video.codec_name ? String(video.codec_name).toLowerCase() : null,
    audioCodec: audio && audio.codec_name ? String(audio.codec_name).toLowerCase() : null,
    hasAudio: !!audio,
    width,
    height,
    frameRate: video ? parseRate(video.r_frame_rate) : null,
    durationSeconds: Number(format.duration) > 0 ? Number(format.duration) : null,
    bitRate: Number(format.bit_rate) > 0 ? Number(format.bit_rate) : null,
    videoCopyable: !!(video && video.codec_name && MP4_VIDEO_CODECS.test(String(video.codec_name)))
  };
}

function parseRate(value) {
  const text = String(value || "");
  const match = /^(\d+)\/(\d+)$/.exec(text);
  if (match) {
    const denominator = Number(match[2]);
    return denominator > 0 ? Number(match[1]) / denominator : null;
  }
  const direct = Number(text);
  return Number.isFinite(direct) && direct > 0 ? direct : null;
}

function emptyProbe() {
  return { videoCodec: null, audioCodec: null, hasAudio: false, width: null, height: null, frameRate: null, durationSeconds: null, bitRate: null, videoCopyable: false };
}

function runOnce(command, args, spawnProcess) {
  const launch = spawnProcess || spawn;
  return new Promise((resolve, reject) => {
    const child = launch(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() }));
  });
}

module.exports = { probeSourceStreams, interpretProbe, ffprobePath, MP4_VIDEO_CODECS };
