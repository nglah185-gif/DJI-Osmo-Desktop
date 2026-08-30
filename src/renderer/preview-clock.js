(function () {
  "use strict";

  // ~3 frames at 30fps. Tight enough that drift is invisible, loose enough to
  // absorb normal IPC and paint jitter without discarding usable frames.
  const PREVIEW_SKEW_TOLERANCE = 0.1;
  // Beyond this the pipe and the audio clock have genuinely diverged. Holding a
  // frame can only recover jitter: if the decoder is persistently ahead, waiting
  // for the clock to catch up never terminates because every dropped frame
  // pushes the reported source time further forward. Resync instead.
  const PREVIEW_RESYNC_SKEW = 0.5;
  // A resync respawns ffmpeg. Rate limit it so a slow decode cannot turn into a
  // process restart storm, which is itself indistinguishable from a freeze.
  const PREVIEW_RESYNC_COOLDOWN_MS = 700;
  // Trim clamping writes video.currentTime. Without a dead band the write is
  // never exactly equal to the target, so it re-fires on every timeupdate and
  // each resulting `seeked` restarts the decoder.
  const TRIM_CLAMP_TOLERANCE = 0.05;
  // ffmpeg needs roughly half a second to spawn and emit its first frame, but
  // the hidden video starts its clock at once. Both then advance at 1x, so the
  // pipe sits a constant distance behind the clock forever. That is a fixed
  // offset, not drift, and the drop path cannot recover from it: every frame is
  // late by the same amount, so every frame is discarded and nothing is ever
  // painted. Measure the offset and subtract it instead of dropping.
  //
  // Only a *stable* lag may be compensated. A genuinely slipping decoder must
  // still drop, otherwise the canvas would silently drift out of sync with the
  // audio. Stability is judged by requiring consecutive late frames whose skew
  // agrees to within this band.
  const LAG_STABILITY_BAND = 0.08;
  // At 60fps this is ~0.2s of evidence: long enough to reject one-off IPC
  // hiccups, short enough that startup lag is absorbed almost immediately.
  const LAG_SAMPLES_REQUIRED = 12;

  function num(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  /**
   * Decide what to do with a freshly arrived preview frame relative to the
   * hidden video element, which remains the authoritative audio/timeline clock.
   *
   *   accept - within tolerance, paint it
   *   drop   - materially behind the clock, discard it
   *   hold   - slightly ahead, keep it until the clock reaches it (jitter)
   *   resync - far ahead, the pipe has diverged and must be relaunched
   */
  function frameDecision(input) {
    const options = input || {};
    const frameSourceTime = Number(options.frameSourceTime);
    const clockSourceTime = Number(options.clockSourceTime);
    const tolerance = num(options.tolerance, PREVIEW_SKEW_TOLERANCE);
    const resyncSkew = num(options.resyncSkew, PREVIEW_RESYNC_SKEW);
    if (!Number.isFinite(frameSourceTime) || !Number.isFinite(clockSourceTime)) {
      return { action: "accept", skew: 0 };
    }
    const rawSkew = frameSourceTime - clockSourceTime;
    // Compensate a previously measured startup lag so the frames that follow are
    // judged on their drift from the pipe's own baseline, not on the constant
    // offset every one of them inherits.
    const offset = num(options.lagOffset, 0);
    const skew = rawSkew - offset;
    if (skew < -tolerance) return { action: "drop", skew, rawSkew };
    if (skew <= tolerance) return { action: "accept", skew };
    // A paused clock will never advance, so holding would strand the frame and
    // leave a stale image on screen. Paint it and let the still be correct.
    if (options.paused) return { action: "accept", skew };
    if (skew > resyncSkew) return { action: "resync", skew };
    return { action: "hold", skew };
  }

  /** A held frame is released once the clock has caught up to it. */
  function shouldReleaseHeldFrame(input) {
    const options = input || {};
    const frameSourceTime = Number(options.frameSourceTime);
    const clockSourceTime = Number(options.clockSourceTime);
    const tolerance = num(options.tolerance, PREVIEW_SKEW_TOLERANCE);
    if (!Number.isFinite(frameSourceTime) || !Number.isFinite(clockSourceTime)) return false;
    if (options.paused) return true;
    // Same baseline as frameDecision, or a frame held under compensation could
    // never satisfy the release test and would strand the canvas.
    return frameSourceTime - clockSourceTime - num(options.lagOffset, 0) <= tolerance;
  }

  /**
   * Tracks how far a pipe persistently sits behind the clock and, once the lag
   * proves stable, reports it as an offset for frameDecision to subtract.
   *
   * Only consecutive late frames of near-identical skew are treated as evidence.
   * A frame arriving on time, or a lag that is still moving, clears the run: a
   * decoder that is genuinely falling further behind must keep dropping rather
   * than have its drift quietly absorbed.
   */
  function createLagTracker(config) {
    const options = config || {};
    const band = num(options.stabilityBand, LAG_STABILITY_BAND);
    const required = num(options.samplesRequired, LAG_SAMPLES_REQUIRED);
    let offset = 0;
    let runSkew = 0;
    let runCount = 0;
    return {
      /** Feed the raw (uncompensated) skew of every frame that was judged late. */
      observe(rawSkew) {
        const skew = Number(rawSkew);
        if (!Number.isFinite(skew)) return offset;
        if (runCount > 0 && Math.abs(skew - runSkew) <= band) {
          // Average across the run so one jittery sample cannot set the baseline.
          runSkew = runSkew + (skew - runSkew) / (runCount + 1);
          runCount += 1;
        } else {
          runSkew = skew;
          runCount = 1;
        }
        if (runCount >= required) offset = runSkew;
        return offset;
      },
      /** An in-window frame proves the pipe is keeping up; stop accumulating. */
      noteHealthy() {
        runCount = 0;
      },
      /** A relaunch or seek invalidates the measurement entirely. */
      reset() {
        offset = 0;
        runCount = 0;
        runSkew = 0;
      },
      get offset() {
        return offset;
      }
    };
  }

  function resyncAllowed(lastResyncAt, now, cooldownMs) {
    const previous = num(lastResyncAt, 0);
    const stamp = num(now, 0);
    const cooldown = num(cooldownMs, PREVIEW_RESYNC_COOLDOWN_MS);
    if (!previous) return true;
    return stamp - previous >= cooldown;
  }

  /**
   * Trim clamping for the edit-mode clock. Returns `seekTo: null` whenever the
   * playhead is already inside the dead band, so no redundant currentTime write
   * (and therefore no decoder restart) is issued.
   */
  function trimClampAction(currentTime, clip, tolerance) {
    const current = num(currentTime, 0);
    const band = num(tolerance, TRIM_CLAMP_TOLERANCE);
    const sourceIn = num(clip && clip.sourceInUs, 0) / 1000000;
    const sourceOut = num(clip && clip.sourceOutUs, 0) / 1000000;
    if (sourceOut > sourceIn && current >= sourceOut - 0.01) {
      const seekTo = Math.abs(current - sourceOut) > band ? sourceOut : null;
      return { seekTo, shouldPause: true };
    }
    if (current < sourceIn - band) return { seekTo: sourceIn, shouldPause: false };
    return { seekTo: null, shouldPause: false };
  }

  const api = {
    PREVIEW_SKEW_TOLERANCE,
    PREVIEW_RESYNC_SKEW,
    PREVIEW_RESYNC_COOLDOWN_MS,
    TRIM_CLAMP_TOLERANCE,
    LAG_STABILITY_BAND,
    LAG_SAMPLES_REQUIRED,
    frameDecision,
    shouldReleaseHeldFrame,
    createLagTracker,
    resyncAllowed,
    trimClampAction
  };
  if (typeof window !== "undefined") window.__previewClock = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
