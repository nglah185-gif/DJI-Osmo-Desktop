"use strict";
const { spawn } = require("node:child_process");
const { buildFilterGraph } = require("./filter-graph-builder");
const { previewFitFilter } = require("./preview-fit");

function playbackPacing(frameRate, playbackRate) {
  const fps = Math.max(1, Number(frameRate) || 30);
  const speed = Math.max(0.1, Number(playbackRate) || 1);
  return {
    intervalMs: Math.max(16, Math.min(100, 1000 / (fps * Math.min(1, speed)))),
    frameStep: speed > 1 ? Math.max(1, Math.round(speed)) : 1
  };
}

/**
 * PreviewFrameStreamer - main-side session manager for the continuous real-time
 * Preview Renderer (REALTIME_PREVIEW_ARCH.md, Option B).
 *
 * Spawns ONE long-lived ffmpeg process per asset that decodes the LRF source,
 * applies the EXACT `buildFilterGraph` output already used by single-frame
 * preview (ffmpeg-frame-renderer.js) and export (ffmpeg-export-renderer.js),
 * and streams effect-applied raw RGB24 frames to the renderer over IPC.
 *
 * Preview == Export is guaranteed by construction because both reuse
 * `buildFilterGraph` verbatim (only the final scale is swapped in, exactly like
 * ffmpeg-frame-renderer.js:10).
 *
 * Lifecycle per asset:
 *   start   -> spawn ffmpeg at the given timeline position and stream frames
 *   update  -> graph changed (color/geometry/watermark) -> restart at current pos
 *   seek    -> restart at a new timeline position
 *   pause   -> kill the child (canvas freezes); session + last frame retained
 *   resume  -> restart at the current timeline position
 *   stop    -> kill the child and drop the session (asset switch / leave edit)
 */
class PreviewFrameStreamer {
  constructor(options = {}) {
    this.lutRegistry = options.lutRegistry;
    this.styleRegistry = options.styleRegistry || null;
    this.cacheRoot = options.cacheRoot || null;
    this.ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
    this.width = options.width || 640;
    this.height = options.height || 360;
    this.hardwareDecode = options.hardwareDecode !== false;
    this.defaultFrameRate = options.frameRate || 30;
    this.spawnProcess = options.spawnProcess || spawn;
    this.sessions = new Map();
    // Children whose kill was attempted but whose exit has not been observed.
    // Retried on shutdownNow so a failed kill cannot outlive the app.
    this.orphans = new Set();
  }

  _frameBytes() { return this.width * this.height * 3; }

  /** Map a renderer clock position (seconds) to the SOURCE position the pipe
   *  must seek to. Reuses the exact mapping from main.js editor:preview-frame so
   *  the continuous pipe and the single-frame still agree on the read cursor. */
  _mapSeconds(timelineSeconds, editor, frameRate = this.defaultFrameRate) {
    const clip = (editor && editor.clip) || {};
    const sourceIn = Number(clip.sourceInUs || 0) / 1000000;
    const sourceOut = Number(clip.sourceOutUs || 0) / 1000000;
    const mapped = Number(timelineSeconds || 0) * Number(clip.playbackRate || 1) + sourceIn;
    if (!(sourceOut > sourceIn)) return Math.max(sourceIn, mapped);
    // Browser duration and ffprobe duration commonly differ by a few ms. If an
    // effect is changed on the final frame, seeking at/after sourceOut makes
    // ffmpeg exit cleanly without emitting a frame, leaving the canvas blank.
    const lastFrame = Math.max(sourceIn, sourceOut - 1 / Math.max(1, Number(frameRate) || this.defaultFrameRate));
    return Math.min(lastFrame, Math.max(sourceIn, mapped));
  }

  async start({ assetId, sourcePath, editor, graph, webContents, timelineSeconds, frameRate }) {
    await this.stop(assetId);
    const session = {
      assetId, sourcePath, editor, graph, webContents,
      child: null, stopping: false, paused: false, closed: false, seekSeconds: null,
      frameRate: frameRate || this.defaultFrameRate,
      // Latest authoritative clock position reported by the renderer's hidden
      // <video>. null until the first report, in which case pacing is open-loop
      // (the pre-existing behaviour) so a renderer that never reports still runs.
      clockSourceTime: null, clockReportedAt: 0,
      launchGeneration: 0, launchRequestGeneration: 0
    };
    this.sessions.set(assetId, session);
    session.seekSeconds = this._mapSeconds(timelineSeconds, editor, session.frameRate);
    const launched = await this._enqueueLaunch(session);
    return { started: true, assetId, launchGeneration: launched && launched.launchGeneration || session.launchGeneration };
  }

  /**
   * Renderer -> pipe clock feedback. Called on every timeupdate/rAF tick with the
   * hidden video's source position. This is the only thing that keeps the decoder
   * from running away from the display clock.
   */
  reportClock(assetId, clockSourceTime) {
    const session = this.sessions.get(assetId);
    if (!session) return { reported: false, assetId };
    const value = Number(clockSourceTime);
    if (!Number.isFinite(value)) return { reported: false, assetId };
    session.clockSourceTime = value;
    session.clockReportedAt = Date.now();
    return { reported: true, assetId };
  }

  async update(assetId, { editor, graph, timelineSeconds }) {
    const session = this.sessions.get(assetId);
    if (!session) return { updated: false, assetId };
    session.editor = editor;
    session.graph = graph;
    session.seekSeconds = this._mapSeconds(timelineSeconds, editor, session.frameRate);
    // The read cursor moved, so any previously reported clock refers to a
    // different position. Stale feedback here would gate the first frame of the
    // relaunched pipe and reproduce the freeze.
    session.clockSourceTime = null;
    session.clockReportedAt = 0;
    // Effect changes must refresh the displayed still even when playback is
    // paused or ended. The renderer pauses again after receiving that frame.
    session.paused = false;
    const launched = await this._enqueueLaunch(session);
    return { updated: true, assetId, launchGeneration: launched && launched.launchGeneration || session.launchGeneration };
  }

  async seek(assetId, timelineSeconds) {
    const session = this.sessions.get(assetId);
    if (!session) return { seeked: false, assetId };
    session.seekSeconds = this._mapSeconds(timelineSeconds, session.editor, session.frameRate);
    session.clockSourceTime = null;
    session.clockReportedAt = 0;
    session.paused = false;
    const launched = await this._enqueueLaunch(session);
    return { seeked: true, assetId, launchGeneration: launched && launched.launchGeneration || session.launchGeneration };
  }

  async resume(assetId, timelineSeconds) {
    const session = this.sessions.get(assetId);
    if (!session) return { resumed: false, assetId };
    session.seekSeconds = this._mapSeconds(timelineSeconds, session.editor, session.frameRate);
    session.clockSourceTime = null;
    session.clockReportedAt = 0;
    session.paused = false;
    const launched = await this._enqueueLaunch(session);
    return { resumed: true, assetId, launchGeneration: launched && launched.launchGeneration || session.launchGeneration };
  }

  pause(assetId) {
    const session = this.sessions.get(assetId);
    if (session) {
      session.paused = true;
      session.stopping = true;
      this._killChild(session);
    }
    return { paused: true, assetId };
  }

  async stop(assetId) {
    const session = this.sessions.get(assetId);
    if (session) {
      session.closed = true;
      session.paused = true;
      session.stopping = true;
      // Invalidate the session before waiting on process cleanup. A filter graph
      // rebuild or a platform process callback must never make Stop/Retry wait
      // on the same launch promise that the user is trying to cancel.
      this.sessions.delete(assetId);
      await this._killChild(session);
    }
    return { stopped: true, assetId };
  }

  async shutdown() {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map(id => this.stop(id)));
  }

  shutdownNow() {
    for (const session of this.sessions.values()) {
      session.closed = true;
      session.paused = true;
      session.stopping = true;
      if (session.paceTimer) { clearTimeout(session.paceTimer); session.paceTimer = null; }
      const child = session.child;
      session.child = null;
      if (child) {
        try { child.kill("SIGKILL"); } catch { /* process already exited */ }
      }
    }
    this.sessions.clear();
    // Final sweep for children whose earlier kill did not take effect.
    for (const child of this.orphans) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    this.orphans.clear();
  }

  _killChild(session, options = {}) {
    const waitForExit = options.waitForExit !== false;
    if (session.paceTimer) { clearTimeout(session.paceTimer); session.paceTimer = null; }
    const child = session.child;
    if (!child) return Promise.resolve();
    session.child = null;
    session.stopping = true;
    // The handle is cleared above so a superseded launch cannot write to the
    // session, but that also makes the process unreachable if the kill fails.
    // Track it until exit is observed; otherwise a TerminateProcess failure
    // during rapid seeking leaks an ffmpeg that holds the source file open and
    // outlives the app, with no reference left anywhere to clean it up.
    this.orphans.add(child);
    return new Promise(resolve => {
      let settled = false;
      let timer = null;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        child.removeListener("close", done);
        child.removeListener("exit", done);
        resolve();
      };
      const release = () => { this.orphans.delete(child); };
      child.once("close", release);
      child.once("exit", release);
      if (child.exitCode !== null || child.signalCode !== null) { release(); }
      child.once("close", done);
      child.once("exit", done);
      if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
      try {
        if (child.kill("SIGKILL") === false) { done(); return; }
        // During an effect/seek replacement the generation guard makes the old
        // child harmless as soon as it is marked stale. Do not hold the new
        // launch behind a slow Windows process-close notification.
        if (!waitForExit) { done(); return; }
      } catch { done(); return; }
      // Windows can occasionally acknowledge TerminateProcess without emitting
      // another close event. Never leave the per-asset launch queue blocked.
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        done();
      }, 1500);
    });
  }

  async _launch(session) {
    // Updates and seeks can arrive faster than ffmpeg can be torn down. Queue
    // launches per asset so a late cleanup cannot kill the replacement child.
    await this._killChild(session, { waitForExit: false });
    if (session.closed || session.paused || this.sessions.get(session.assetId) !== session) return;
    session.stopping = false;
    const { assetId, sourcePath, editor, graph, frameRate } = session;
    // Killed children can still flush stdout and timers on the next turn.
    // Tag each launch so stale callbacks cannot mutate the replacement.
    const launchGeneration = ++session.launchGeneration;

    const previewGraph = { ...(graph || {}), previewSize: { width: this.width, height: this.height } };
    // Preview reads raw rgb24 over the pipe (see -pix_fmt below), so it asks the
    // builder for that output format explicitly and passes the fit filter as the
    // output suffix. Both were previously patched in by string-replacing the
    // graph text, which breaks silently whenever the builder's last stage changes.
    const fit = previewFitFilter(this.width, this.height);
    const compiled = await buildFilterGraph({
      graph: previewGraph, lutRegistry: this.lutRegistry, styleRegistry: this.styleRegistry, cacheRoot: this.cacheRoot,
      outputFormat: "rgb24", outputSuffix: fit
    });
    if (session.closed || session.paused || this.sessions.get(session.assetId) !== session) return;
    const filterGraph = compiled.filterGraph;

    const decode = this.hardwareDecode && process.platform === "win32" ? ["-hwaccel", "auto"] : [];
    const seek = session.seekSeconds || 0;
    // Bound output to the clip's sourceOut so a trimmed clip does not play past
    // its out point (mirrors export's -t). Clamped to >= 0.
    const clip = (editor && editor.clip) || {};
    const sourceOut = Number(clip.sourceOutUs || 0) / 1000000;
    const durationArg = sourceOut > seek ? sourceOut - seek : null;
    const playbackRate = Math.max(0.1, Number(clip.playbackRate || 1));
    // Decode fast enough to satisfy the display cadence but no faster. Fast
    // playback consumes frameStep source frames per tick, so the read rate must
    // scale with it; a small margin absorbs decode jitter without letting the
    // buffer grow into the drop threshold.
    // Exactly playback speed. A margin here (previously 1.15) makes the decoder
    // outrun the 1x consumer for good: the buffer stays above the drop
    // threshold, every sendOne() discards frames and advances sourceFrameIndex,
    // and the reported sourceTime therefore runs ahead of the audio clock
    // without bound. preview-clock then answers hold/resync forever and the
    // canvas freezes after the first frame. Pacing is closed-loop instead: the
    // renderer reports its clock and sendOne() gates on it.
    const readRate = Math.max(0.1, Math.min(16, playbackRate));
    const args = [
      "-v", "error",
      ...decode,
      // Read the source at playback speed. Without a read rate limit ffmpeg
      // decodes 720p LRF far faster than the ~30fps consumer drains it, the
      // buffer stays above the drop threshold, and every sendOne() discards
      // frames while advancing sourceTime -- the preview then runs ahead of the
      // audio clock and looks like fast-forward. A small initial burst keeps
      // the first frame after a seek fast.
      "-readrate", String(readRate),
      // Burst only enough to fill the small queue after a seek. A full second of
      // unthrottled decode (the previous value) delivers ~30 frames before the
      // consumer has drained two, which is itself enough to push sourceTime past
      // the resync threshold on the very first tick.
      "-readrate_initial_burst", "0.15",
      "-ss", String(seek),
      "-i", sourcePath,
      ...compiled.inputArgs,
      "-filter_complex", filterGraph,
      "-map", "[outv]",
      ...(durationArg !== null ? ["-t", String(durationArg)] : []),
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "-"
    ];

    const child = this.spawnProcess(this.ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    session.child = child;
    child.stderr.setEncoding("utf8");
    let stderrText = "";
    // ffmpeg reaching the end of the source exits with code 0. That is not an
    // error, but it is also not a no-op: without an explicit end-of-source
    // signal the paced drain stops and the canvas keeps displaying the last
    // decoded frame forever, which reads as a frozen player.
    let sourceEnded = false;
    child.stderr.on("data", chunk => {
      if (chunk && chunk.trim()) { stderrText += chunk; console.error("[preview-streamer:" + assetId + "] " + chunk.trim()); }
    });
    child.on("error", err => console.error("[preview-streamer:" + assetId + "] spawn error", err));
    child.on("close", code => {
      // A replacement launch may already own the session when the old process
      // finally emits `close`. That exit was intentional and must not surface
      // as a preview failure or blank the current canvas.
      if (session.child !== child || session.launchGeneration !== launchGeneration) return;
      session.child = null;
      if (!session.stopping && code !== 0) {
        console.error("[preview-streamer:" + assetId + "] ffmpeg exited", code);
        if (session.webContents && !session.webContents.isDestroyed?.()) session.webContents.send("preview:error", { assetId, code, message: stderrText.trim() || "Preview process exited unexpectedly" });
        return;
      }
      // Clean EOF. Frames decoded before the exit are still sitting in the
      // buffer, so the paced drain has to keep running; only once it empties is
      // the source genuinely finished.
      if (!session.stopping && code === 0) sourceEnded = true;
    });

    const fb = this._frameBytes();
    // Slow motion sends consecutive frames less often. Fast playback keeps a
    // smooth display cadence and skips source frames, matching the hidden
    // video's playback clock without asking Windows timers to exceed 60 Hz.
    const pacing = playbackPacing(frameRate || this.defaultFrameRate, playbackRate);
    const paceInterval = pacing.intervalMs;
    const frameStep = pacing.frameStep;
    let nextFrameAt = Date.now() + paceInterval;
    // Keep the preview low-latency. A large decoded queue makes the canvas
    // display old frames after IPC or paint stalls, which looks like slow
    // motion and eventually blocks the renderer.
    const CAP_FRAMES = 4;
    // Depth sendOne() trims the queue back to, and the depth at which a paused
    // stdout resumes. These must agree: resuming only at zero drained the pipe
    // completely between every pause, so delivery stalled in bursts.
    const TARGET_FRAMES = 2;
    const RESUME_FRAMES = TARGET_FRAMES;
    // How far the pipe may run ahead of the renderer clock before sendOne()
    // withholds. Must stay below preview-clock's hold threshold so a frame that
    // does get sent is inside the accept band by the time it is painted.
    const LEAD_SECONDS = 0.08;
    // A clock report older than this is treated as absent, so the gate reverts
    // to open-loop pacing rather than withholding frames indefinitely.
    const CLOCK_STALE_MS = 500;
    let sourceFrameIndex = 0;
    let buf = Buffer.allocUnsafe(Math.max(fb * 4, 64 * 1024));
    let readIdx = 0;
    let writeIdx = 0;
    let backpressured = false;

    // After a clean EOF `session.child` is null while buffered frames remain, so
    // ownership is checked without it. The generation guard still keeps a
    // superseded launch from writing over the current one.
    const stillOwns = () => (session.child === child || sourceEnded) && session.launchGeneration === launchGeneration;

    // Per-launch counter. Only used to exempt the first frame from the clock gate.
    let framesSent = 0;

    const sendOne = () => {
      if (session.paused || session.closed || !stillOwns()) return;
      if (!session.webContents || session.webContents.isDestroyed?.()) {
        session.closed = true;
        this.stop(assetId).catch(() => {});
        return;
      }
      // Closed-loop gate. The renderer's hidden <video> is the authoritative
      // clock; it reports its position via reportClock(). If the next frame we
      // would emit is already ahead of that clock, emitting it can only produce a
      // hold on the far side, so withhold it this tick and let the clock advance.
      // This is what keeps sourceTime and the clock coupled instead of drifting.
      // The first frame of a launch is exempt. It has to reach the renderer to
      // satisfy the launchGeneration waiter and to repaint the still while
      // paused. Gating it deadlocks: seek is mapped through the trim offset and
      // can legitimately sit ahead of a clock that, being paused, never
      // advances, so the gate would never reopen and the renderer would fail
      // with preview.timeout after 8s instead of showing a frame.
      // Trim the queue FIRST, then gate. Dropping after the check advanced
      // sourceFrameIndex past the value that was validated, so the frame that
      // actually went out could sit a whole drop-batch ahead of the clock -- far
      // outside the accept band the gate exists to enforce. preview-clock then
      // answered hold for a frame the gate had already approved, which is the
      // skew spike seen right before delivery stopped.
      const effectiveRate = Math.max(1, Number(frameRate || this.defaultFrameRate));
      const clock = session.clockSourceTime;
      const clockUsable = framesSent > 0 && typeof clock === "number" && Number.isFinite(clock)
        && (Date.now() - (session.clockReportedAt || 0)) <= CLOCK_STALE_MS;
      const bufferedFrames = Math.floor((writeIdx - readIdx) / fb);
      if (clockUsable) {
        // Closed loop: discard only frames the display clock has already passed.
        // Trimming on queue DEPTH instead (the previous rule) destroys good
        // frames at 1x: a tick withheld by the gate below consumes nothing, the
        // queue therefore exceeds TARGET_FRAMES, and the next tick discards
        // frames the renderer had not yet shown. Measured 22% loss on 10-bit
        // LRF at 1x, where the decoder is rate-limited and cannot run away at
        // all. Queue growth is already bounded by stdout backpressure at
        // CAP_FRAMES, so depth alone is not a reason to drop anything.
        const behindBy = clock - LEAD_SECONDS - (seek + sourceFrameIndex / effectiveRate);
        if (behindBy > 0 && bufferedFrames > 1) {
          const stale = Math.min(bufferedFrames - 1, Math.floor(behindBy * effectiveRate));
          if (stale > 0) { readIdx += stale * fb; sourceFrameIndex += stale; }
        }
      } else if (bufferedFrames > TARGET_FRAMES) {
        // Open loop (no clock yet, or the renderer stopped reporting): fall back
        // to bounding latency by depth, which is the only signal available.
        const dropFrames = bufferedFrames - TARGET_FRAMES;
        readIdx += dropFrames * fb;
        sourceFrameIndex += dropFrames;
      }

      const nextSourceTime = seek + sourceFrameIndex / effectiveRate;
      // A clock that stops advancing must not withhold frames forever. Without
      // the staleness bound a stalled or silent renderer leaves the gate shut,
      // the buffer never drains, EOF never fires, and the pace timer plus the
      // ffmpeg child spin for the lifetime of the session.
      if (clockUsable && nextSourceTime - clock > LEAD_SECONDS) return;
      if (readIdx + fb * frameStep <= writeIdx) {
        const frame = buf.subarray(readIdx, readIdx + fb);
        readIdx += fb * frameStep;
        const sourceTime = seek + sourceFrameIndex / Math.max(1, Number(frameRate || this.defaultFrameRate));
        sourceFrameIndex += frameStep;
        try {
          session.webContents.send("preview:frame", {
            assetId, width: this.width, height: this.height,
            data: Buffer.from(frame),  // copy so later compaction is safe
            pts: Date.now(), sourceTime, launchGeneration
          });
          framesSent += 1;
        } catch {
          session.closed = true;
          this.stop(assetId).catch(() => {});
        }
      }
    };

    const manageBackpressure = () => {
      if (readIdx > fb * 4) { buf.copy(buf, 0, readIdx, writeIdx); writeIdx -= readIdx; readIdx = 0; }
      const buffered = Math.floor((writeIdx - readIdx) / fb);
      if (buffered >= CAP_FRAMES && !backpressured) { child.stdout.pause(); backpressured = true; }
      else if (buffered <= RESUME_FRAMES && backpressured) { child.stdout.resume(); backpressured = false; }
    };

    child.stdout.on("data", chunk => {
      if (session.child !== child || session.launchGeneration !== launchGeneration || session.stopping || session.paused) return;
      if (writeIdx - readIdx + chunk.length > buf.length) {
        if (readIdx > 0) { buf.copy(buf, 0, readIdx, writeIdx); writeIdx -= readIdx; readIdx = 0; }
      }
      if (writeIdx + chunk.length > buf.length) {
        let cap = buf.length;
        while (cap < writeIdx + chunk.length) cap *= 2;
        const next = Buffer.allocUnsafe(cap);
        buf.copy(next, 0, 0, writeIdx);
        buf = next;
      }
      chunk.copy(buf, writeIdx);
      writeIdx += chunk.length;
    });

    const pace = () => {
      if (session.stopping || session.paused || session.closed || !stillOwns()) return;
      sendOne();
      if (session.stopping || session.paused || session.closed || !stillOwns()) return;
      // Buffer drained after a clean EOF: report end-of-source exactly once and
      // stop the timer. This is the signal whose absence left the canvas holding
      // the last frame with no way to recover.
      // Must mirror sendOne()'s consumption requirement (fb * frameStep). At
      // playbackRate >= 1.5 frameStep is >= 2, so a 1-frame residue could never
      // be consumed while this test still called the buffer non-empty: no
      // preview:ended, timer looping forever, canvas frozen on the last frame.
      if (sourceEnded && readIdx + fb * frameStep > writeIdx) {
        session.paceTimer = null;
        session.paused = true;
        const lastSourceTime = seek + sourceFrameIndex / Math.max(1, Number(frameRate || this.defaultFrameRate));
        if (session.webContents && !session.webContents.isDestroyed?.()) {
          session.webContents.send("preview:ended", { assetId, launchGeneration, sourceTime: lastSourceTime });
        }
        return;
      }
      manageBackpressure();
      // Schedule against a monotonic deadline instead of chaining a fixed
      // timeout. Node timer and IPC overhead must not accumulate into a
      // progressively slower preview clock.
      nextFrameAt += paceInterval;
      const delay = Math.max(0, nextFrameAt - Date.now());
      if (delay > paceInterval * 4) nextFrameAt = Date.now() + paceInterval;
      session.paceTimer = setTimeout(pace, delay);
    };
    if (session.paceTimer) clearTimeout(session.paceTimer);
    session.paceTimer = setTimeout(pace, paceInterval);
    return { launchGeneration };
  }

  _enqueueLaunch(session) {
    const requestGeneration = ++session.launchRequestGeneration;
    const previous = session.launchPromise || Promise.resolve();
    // A newer effect/seek request may arrive while the current ffmpeg launch is
    // still being prepared. Skip queued intermediate launches so only the
    // latest requested graph starts another decoder process.
    const next = previous.catch(() => {}).then(() => {
      if (requestGeneration !== session.launchRequestGeneration) return { launchGeneration: session.launchGeneration, skipped: true };
      return this._launch(session);
    });
    const tracked = next.finally(() => {
      if (session.launchPromise === tracked) session.launchPromise = null;
    });
    session.launchPromise = tracked;
    return tracked;
  }
}

module.exports = { PreviewFrameStreamer, playbackPacing };
