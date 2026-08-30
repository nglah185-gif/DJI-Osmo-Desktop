/**
 * Closed-loop preview probe.
 *
 * The older preview-throughput-probe.js never calls streamer.reportClock(), so
 * session.clockSourceTime stays null and the decoder gate runs open-loop. That
 * probe therefore cannot observe the deadlock that the gate introduces, which is
 * why it passed while real playback froze.
 *
 * This probe emulates the *fixed* renderer instead: a clock that advances in
 * real time like the hidden <video>, and a paint loop on its own 60Hz cadence
 * that reports that clock back to the streamer -- which is exactly what
 * startPreviewLoop() restores.
 *
 * Run with `--no-clock` to emulate the broken renderer (paint loop never
 * started, so the clock is only reported when a frame arrives). That mode is
 * expected to stall, and is what makes this a controlled comparison rather than
 * a single observation.
 *
 * Usage: node scripts/preview-closedloop-probe.js [lrfPath] [--no-clock] [--seconds=8]
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { PreviewFrameStreamer } = require("../src/renderers/preview-frame-streamer");
const previewClock = require("../src/renderer/preview-clock");

const args = process.argv.slice(2);
const CLOSED_LOOP = !args.includes("--no-clock");
const SECONDS = Number((args.find(a => a.startsWith("--seconds=")) || "").split("=")[1]) || 8;
const RATE = Number((args.find(a => a.startsWith("--rate=")) || "").split("=")[1]) || 1;
const explicitPath = args.find(a => !a.startsWith("--"));

function findLrf(explicit) {
  if (explicit) return explicit;
  const roots = [
    path.resolve(__dirname, "..", "..", "dji-test-media"),
    path.resolve(__dirname, "..", "dji-test-media")
  ].filter(fs.existsSync);
  for (const root of roots) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (/\.lrf$/i.test(entry.name) && fs.statSync(full).size > 1024 * 1024) return full;
      }
    }
  }
  return null;
}

async function main() {
  const sourcePath = findLrf(explicitPath);
  if (!sourcePath) throw new Error("no LRF fixture found");

  const ffmpegPath = process.env.FFMPEG_PATH
    || path.resolve(__dirname, "..", "release", "DJI-Osmo-Desktop-0.1.0-win-x64-portable", "resources", "bin", "ffmpeg.exe");
  if (!fs.existsSync(ffmpegPath)) throw new Error("ffmpeg not found at " + ffmpegPath);

  const frameRate = 30000 / 1001;
  const records = [];
  let clockStarted = 0;
  let lastFrameAt = 0;
  let reportCount = 0;

  // Mirrors the renderer's hidden <video>: paused until the first frame is on
  // screen, then advancing in real time.
  // Source time advances at RATE x wall clock, mirroring a <video> whose
// playbackRate is set. Reporting a 1x clock at 2x playback would make the gate
// hold correctly and mask what we are trying to measure.
const clockNow = () => (clockStarted ? ((Date.now() - clockStarted) / 1000) * RATE : 0);

  const streamer = new PreviewFrameStreamer({
    lutRegistry: null, styleRegistry: null,
    cacheRoot: path.join(os.tmpdir(), "preview-closedloop-cache"),
    width: 640, height: 360, ffmpegPath
  });

  let endedAt = null;
  const webContents = {
    isDestroyed: () => false,
    send(channel, payload) {
      // End-of-source is a normal terminal state, not a stall. Without tracking
      // it, a run longer than the clip counts the post-EOF silence as a freeze.
      // Wall-clock, to match records[].at. clockNow() is SOURCE time (scaled by
      // RATE); mixing the two made 2x look like a 1.4s silent tail and reported
      // STALLED while delivery was in fact correct.
      if (channel === "preview:ended") { endedAt = clockStarted ? (Date.now() - clockStarted) / 1000 : 0; return; }
      if (channel === "preview:error") { console.log("  preview:error:", payload && payload.message); return; }
      if (channel !== "preview:frame") return;
      const at = Date.now();
      if (!clockStarted) clockStarted = at; // first frame releases the launch hold
      const clockSourceTime = clockNow();
      const decision = previewClock.frameDecision({
        frameSourceTime: payload.sourceTime,
        clockSourceTime,
        paused: false
      });
      records.push({
        at: (at - clockStarted) / 1000,
        gap: lastFrameAt ? (at - lastFrameAt) / 1000 : 0,
        sourceTime: payload.sourceTime,
        skew: decision.skew,
        action: decision.action
      });
      lastFrameAt = at;
      // The broken renderer reported the clock only from a paint triggered by an
      // arriving frame. Emulate that here so the two modes differ only in who
      // drives the reporting.
      if (!CLOSED_LOOP) { streamer.reportClock("probe", clockSourceTime); reportCount += 1; }
    }
  };

  await streamer.start({
    assetId: "probe",
    sourcePath,
      editor: { clip: { sourceInUs: 0, sourceOutUs: 0, playbackRate: RATE } },
    graph: {},
    webContents,
    timelineSeconds: 0,
    frameRate
  });

  // The restored paint loop: independent 60Hz cadence, not frame-driven.
  let paintTimer = null;
  if (CLOSED_LOOP) {
    paintTimer = setInterval(() => {
      if (!clockStarted) return;
      streamer.reportClock("probe", clockNow());
      reportCount += 1;
    }, 16);
  }

  await new Promise(resolve => setTimeout(resolve, SECONDS * 1000));
  if (paintTimer) clearInterval(paintTimer);
  await streamer.stop("probe").catch(() => {});

  const mode = CLOSED_LOOP ? "CLOSED-LOOP (fixed renderer)" : "FRAME-DRIVEN (broken renderer)";
  console.log("mode          :", mode);
  console.log("source        :", path.basename(sourcePath));
  console.log("clock reports :", reportCount);
  if (!records.length) {
    console.log("frames sent   : 0");
    console.log("VERDICT: NO FRAMES DELIVERED");
    process.exitCode = 1;
    return;
  }

  const counts = records.reduce((acc, r) => { acc[r.action] = (acc[r.action] || 0) + 1; return acc; }, {});
  const gaps = records.map(r => r.gap).slice(1);
  const maxGap = gaps.length ? Math.max(...gaps) : 0;
  const lastAt = records[records.length - 1].at;
  // Only silence *before* end-of-source counts against delivery.
  const deliveryDeadline = endedAt !== null ? endedAt : SECONDS;
  const silentTail = Math.max(0, deliveryDeadline - lastAt);
  const accepted = records.filter(r => r.action === "accept");

  console.log("frames sent   :", records.length);
  console.log("decisions     :", JSON.stringify(counts));
  console.log("accept ratio  :", (accepted.length / records.length * 100).toFixed(1) + "%");
  console.log("last frame at :", lastAt.toFixed(3) + "s of " + SECONDS + "s");
  console.log("ended at      :", endedAt === null ? "NOT SIGNALLED" : endedAt.toFixed(3) + "s");
  console.log("silent tail   :", silentTail.toFixed(3) + "s (before EOF)");
  console.log("max frame gap :", maxGap.toFixed(3) + "s");
  console.log("skew first/last:", records[0].skew.toFixed(4), "/", records[records.length - 1].skew.toFixed(4));
  console.log("");
  console.log("trace (every ~" + Math.max(1, Math.floor(records.length / 15)) + "th frame):");
  for (let i = 0; i < records.length; i += Math.max(1, Math.floor(records.length / 15))) {
    const r = records[i];
    console.log(`  t=${r.at.toFixed(3)}s src=${r.sourceTime.toFixed(3)} gap=${r.gap.toFixed(3)} skew=${r.skew >= 0 ? "+" : ""}${r.skew.toFixed(4)} ${r.action}`);
  }

  // A stall is the real symptom: frames stop arriving well before the run ends,
  // or a single gap dwarfs the frame interval. Skew growth alone is not enough,
  // because the gate suppresses frames instead of letting skew grow.
  const STALL_GAP = 0.5;
  const stalled = silentTail > 0.5 || maxGap > STALL_GAP;
  const skewGrowth = records[records.length - 1].skew - records[0].skew;
  // Coverage: how much of the played span actually reached the canvas. A gate
  // that silently discards half the frames still looks smooth by gap alone.
  const span = records[records.length - 1].sourceTime - records[0].sourceTime;
  // Fast playback consumes frameStep source frames per displayed frame by
  // design (playbackPacing in preview-frame-streamer.js), so at 2x only half
  // the source frames are ever meant to reach the canvas. Comparing against the
  // raw source frame count judged correct 2x behaviour as 65% frame loss.
  const frameStep = RATE > 1 ? Math.max(1, Math.round(RATE)) : 1;
  const expected = span * frameRate / frameStep;
  const coverage = expected > 0 ? records.length / expected : 1;
  console.log("");
  console.log("skew growth   :", (skewGrowth >= 0 ? "+" : "") + skewGrowth.toFixed(4) + "s");
  console.log("coverage      :", (coverage * 100).toFixed(1) + "% of expected frames (step=" + frameStep + ") over the played span");
  if (endedAt === null && lastAt < SECONDS - 1) {
    console.log("VERDICT: NO EOF SIGNAL -> player would hold the last frame forever");
    process.exitCode = 4;
  } else if (coverage < 0.8) {
    console.log("VERDICT: FRAME LOSS -> " + (100 - coverage * 100).toFixed(0) + "% of frames discarded (stutter)");
    process.exitCode = 5;
  } else if (stalled) {
    console.log("VERDICT: STALLED -> frames stopped flowing (deadlock/starvation)");
    process.exitCode = 2;
  } else if (skewGrowth > 0.3) {
    console.log("VERDICT: DRIFT -> frames flow but run ahead of the clock");
    process.exitCode = 3;
  } else {
    console.log("VERDICT: HEALTHY -> continuous delivery, skew bounded");
  }
}

main().catch(error => { console.error(error); process.exit(1); });
