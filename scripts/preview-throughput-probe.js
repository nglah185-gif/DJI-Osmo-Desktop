/**
 * Preview throughput probe.
 *
 * Drives the real PreviewFrameStreamer against a real LRF with a fake
 * webContents, and records the skew that preview-clock would compute for every
 * delivered frame against a wall-clock timeline advancing at 1x (which is what
 * the hidden <video> element does).
 *
 * Purpose: prove or disprove that the streamer's own drop-and-advance path
 * pushes sourceTime ahead of the clock without bound, which makes
 * frameDecision() return hold/resync forever and freezes the canvas.
 *
 * Usage: node scripts/preview-throughput-probe.js [lrfPath]
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { PreviewFrameStreamer } = require("../src/renderers/preview-frame-streamer");
const previewClock = require("../src/renderer/preview-clock");

function findLrf(explicit) {
  if (explicit) return explicit;
  const root = path.resolve(__dirname, "..", "..", "dji-test-media");
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.lrf$/i.test(entry.name) && fs.statSync(full).size > 1024 * 1024) return full;
    }
  }
  return null;
}

async function main() {
  const sourcePath = findLrf(process.argv[2]);
  if (!sourcePath) throw new Error("no LRF fixture found");

  const ffmpegPath = process.env.FFMPEG_PATH
    || path.resolve(__dirname, "..", "release", "DJI-Osmo-Desktop-0.1.0-win-x64-portable", "resources", "bin", "ffmpeg.exe");
  if (!fs.existsSync(ffmpegPath)) throw new Error("ffmpeg not found at " + ffmpegPath);

  const frameRate = 30000 / 1001; // LRF real rate, confirmed by ffprobe
  const records = [];
  const started = Date.now();

  const webContents = {
    isDestroyed: () => false,
    send(channel, payload) {
      if (channel !== "preview:frame") return;
      // The hidden <video> advances in real time at 1x from playback start.
      const clockSourceTime = (Date.now() - started) / 1000;
      const decision = previewClock.frameDecision({
        frameSourceTime: payload.sourceTime,
        clockSourceTime,
        paused: false
      });
      records.push({
        at: clockSourceTime,
        sourceTime: payload.sourceTime,
        skew: decision.skew,
        action: decision.action
      });
    }
  };

  const streamer = new PreviewFrameStreamer({
    lutRegistry: null, styleRegistry: null,
    cacheRoot: path.join(require("node:os").tmpdir(), "preview-probe-cache"),
    width: 640, height: 360, ffmpegPath
  });

  await streamer.start({
    assetId: "probe",
    sourcePath,
    editor: { clip: { sourceInUs: 0, sourceOutUs: 0, playbackRate: 1 } },
    graph: {},
    webContents,
    timelineSeconds: 0,
    frameRate
  });

  await new Promise(resolve => setTimeout(resolve, 6000));
  await streamer.stop("probe").catch(() => {});

  if (!records.length) {
    console.log("NO FRAMES DELIVERED");
    process.exit(1);
  }

  const counts = records.reduce((acc, r) => { acc[r.action] = (acc[r.action] || 0) + 1; return acc; }, {});
  const accepted = records.filter(r => r.action === "accept");
  console.log("source        :", sourcePath);
  console.log("frames sent   :", records.length);
  console.log("decisions     :", JSON.stringify(counts));
  console.log("first accept  :", accepted.length ? accepted[0].at.toFixed(3) + "s" : "NONE");
  console.log("last accept   :", accepted.length ? accepted[accepted.length - 1].at.toFixed(3) + "s" : "NONE");
  console.log("skew first    :", records[0].skew.toFixed(4));
  console.log("skew last     :", records[records.length - 1].skew.toFixed(4));
  const mid = records[Math.floor(records.length / 2)];
  console.log("skew mid      :", mid.skew.toFixed(4));
  console.log("");
  console.log("skew trace (every ~10th frame):");
  for (let i = 0; i < records.length; i += Math.max(1, Math.floor(records.length / 20))) {
    const r = records[i];
    console.log(`  t=${r.at.toFixed(3)}s  sourceTime=${r.sourceTime.toFixed(3)}  skew=${r.skew >= 0 ? "+" : ""}${r.skew.toFixed(4)}  ${r.action}`);
  }

  const monotonicGrowth = records[records.length - 1].skew - records[0].skew;
  console.log("");
  console.log("skew growth over run:", (monotonicGrowth >= 0 ? "+" : "") + monotonicGrowth.toFixed(4), "s");
  console.log(monotonicGrowth > 0.3
    ? "VERDICT: skew grows without bound -> canvas starves (hold/resync loop)"
    : "VERDICT: skew bounded -> starvation not reproduced by this path");
}

main().catch(error => { console.error(error); process.exit(1); });
