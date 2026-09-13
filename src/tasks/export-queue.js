"use strict";

// Export queue.
//
// Concurrency is 2 by default, chosen from measurement rather than from taste.
// The first measurement below was taken on the software encoder; the second is
// the current hardware path. They disagree, and the newer one is the truth.
//
// Software encoder (libx264), two 4K60 HEVC clips through the real D-Log graph:
//
//   serial    2 x 8s in 35.9s   0.446x realtime
//   parallel  2 x 8s in 36.1s   0.443x realtime, CPU pegged at 96%
//
// Hardware encoder (h264_mf), one 9.2s 4K D-Log clip, source cached in RAM:
//
//   concurrency 1   56.6s/job   cpu 6.9 / 12 cores   57%
//   concurrency 2   52.1s/job   cpu 7.6 / 12 cores   63%
//   concurrency 3   54.3s/job   cpu 7.5 / 12 cores   62%
//   concurrency 4   51.1s/job   cpu 7.6 / 12 cores   63%
//
// The CPU is NOT the wall: one export leaves five cores idle and four at once
// still do not fill them. Throughput only improves ~1.1x, which means a stage is
// serial and shared across jobs -- the hardware encoder is the only
// single-instance engine in the pipeline, so it is the obvious candidate. Two
// in parallel recovers most of the overlap a serial queue leaves (card read,
// encoder hand-off, ffprobe validation) at twice the memory. More than two adds
// memory and pressure for nothing measurable, so the default stops at 2.
//
// Passthrough copies have their own ceiling: the camera link delivers ~36 MB/s
// whether one or four readers are running, so parallel copying cannot help.
// Batch export is a convenience feature -- pick fifty clips, walk away -- not a
// throughput feature, and the queue is built to make that honest.
//
// `concurrency` stays configurable for the cases where it does help: clips
// spread across different volumes, or a mixed copy/transcode workload where one
// job is I/O bound while the other is CPU bound.

const QUEUED = "queued";
const RUNNING = "running";
const DONE = "done";
const FAILED = "failed";
const CANCELED = "canceled";
const TERMINAL = new Set([DONE, FAILED, CANCELED]);

class ExportQueue {
  constructor(options = {}) {
    this.concurrency = normalizeConcurrency(options.concurrency);
    this.onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : null;
    this.items = new Map();
    // Insertion order is the export order. A Map preserves it, and the queue is
    // small enough (bounded by the selection size) that an array is not needed.
    this.running = new Set();
    this._pumpScheduled = false;
  }

  add(input = {}) {
    const id = String(input.id || "");
    if (!id) throw new Error("Export queue items require an id");
    if (this.items.has(id)) throw new Error("Duplicate export queue id: " + id);
    const item = {
      id,
      batchId: String(input.batchId || ""),
      assetId: String(input.assetId || ""),
      label: String(input.label || ""),
      destination: String(input.destination || ""),
      run: typeof input.run === "function" ? input.run : null,
      state: QUEUED,
      progress: 0,
      error: "",
      result: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      controller: null
    };
    this.items.set(id, item);
    this._emit();
    this._schedulePump();
    return id;
  }

  get(id) {
    const item = this.items.get(String(id || ""));
    return item ? publicItem(item) : null;
  }

  list() {
    return [...this.items.values()].map(publicItem);
  }

  listBatch(batchId) {
    const wanted = String(batchId || "");
    return this.list().filter(item => item.batchId === wanted);
  }

  // Summary for the batch dialog. `active` covers queued+running so the UI can
  // keep the dialog open while work remains.
  summarize(batchId = null) {
    const items = batchId ? this.listBatch(batchId) : this.list();
    const summary = { total: items.length, queued: 0, running: 0, done: 0, failed: 0, canceled: 0, active: 0, overallProgress: 0, doneBytes: 0 };
    let progressSum = 0;
    for (const item of items) {
      if (item.state === QUEUED) summary.queued++;
      else if (item.state === RUNNING) summary.running++;
      else if (item.state === DONE) summary.done++;
      else if (item.state === FAILED) summary.failed++;
      else if (item.state === CANCELED) summary.canceled++;
      if (!TERMINAL.has(item.state)) summary.active++;
      progressSum += item.state === DONE ? 100 : item.progress;
    }
    summary.overallProgress = items.length ? Math.round(progressSum / items.length) : 0;
    return summary;
  }

  // Cancel one item.
  //
  // A running item is marked canceled immediately, before the worker has
  // unwound. Waiting for the worker's rejection left the item in `running` for
  // a few ticks, and a progress event arriving in that window still advanced
  // the bar after the user had already hit cancel.
  //
  // The queue slot stays occupied until the worker actually settles, so a
  // second ffmpeg cannot start while the aborted one is still shutting down.
  // That is handled by the worker's own finally block, not here.
  cancel(id) {
    const item = this.items.get(String(id || ""));
    if (!item || TERMINAL.has(item.state)) return false;
    item.state = CANCELED;
    item.finishedAt = Date.now();
    if (item.controller) {
      try { item.controller.abort(); } catch {}
    }
    this._emit();
    return true;
  }

  cancelBatch(batchId) {
    let canceled = 0;
    for (const item of this.items.values()) {
      if (item.batchId === String(batchId || "") && !TERMINAL.has(item.state) && this.cancel(item.id)) canceled++;
    }
    return canceled;
  }

  cancelAll() {
    let canceled = 0;
    for (const item of this.list()) if (this.cancel(item.id)) canceled++;
    return canceled;
  }

  // Drop finished items. Called by the owner after the UI has consumed them so
  // a long session does not accumulate every export ever run.
  prune(keep = 100) {
    const finished = [...this.items.values()].filter(item => TERMINAL.has(item.state)).sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
    let removed = 0;
    while (finished.length > Math.max(0, Number(keep) || 0)) {
      this.items.delete(finished.shift().id);
      removed++;
    }
    if (removed) this._emit();
    return removed;
  }

  _schedulePump() {
    if (this._pumpScheduled) return;
    this._pumpScheduled = true;
    // Deferred so add() returns before any worker starts. Callers add a whole
    // selection first; starting synchronously would begin the first export
    // before the rest were registered, and the batch dialog would open with a
    // list that was still growing.
    setImmediate(() => { this._pumpScheduled = false; this._pump(); });
  }

  _pump() {
    while (this.running.size < this.concurrency) {
      const next = [...this.items.values()].find(item => item.state === QUEUED);
      if (!next) break;
      this._start(next);
    }
  }

  _start(item) {
    if (TERMINAL.has(item.state) || !item.run) {
      item.state = FAILED;
      item.error = item.run ? "Canceled before start" : "Export item has no worker";
      item.finishedAt = Date.now();
      this._emit();
      return;
    }
    const controller = new AbortController();
    item.controller = controller;
    item.state = RUNNING;
    item.startedAt = Date.now();
    this.running.add(item.id);
    this._emit();

    const report = value => {
      // A late progress callback must not resurrect a canceled item.
      if (item.state !== RUNNING) return;
      const number = Number(value);
      if (!Number.isFinite(number)) return;
      const next = Math.max(item.progress, Math.max(0, Math.min(100, number)));
      if (next === item.progress) return;
      item.progress = next;
      this._emit();
    };

    Promise.resolve()
      .then(() => item.run({ signal: controller.signal, onProgress: report }))
      .then(result => {
        if (item.state === CANCELED) return;
        item.state = DONE;
        item.progress = 100;
        item.result = result === undefined ? null : result;
      })
      .catch(error => {
        if (item.state === CANCELED) return;
        if (controller.signal.aborted || isCancelError(error)) {
          item.state = CANCELED;
          return;
        }
        // One clip failing must not take the rest of the batch with it.
        item.state = FAILED;
        item.error = String(error && error.message ? error.message : error || "Export failed");
      })
      .finally(() => {
        item.finishedAt = Date.now();
        item.controller = null;
        this.running.delete(item.id);
        this._emit();
        this._schedulePump();
      });
  }

  _emit() {
    if (!this.onUpdate) return;
    try { this.onUpdate(this.list()); } catch { /* observers must not break the queue */ }
  }
}

function normalizeConcurrency(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(4, Math.floor(parsed)));
}

function isCancelError(error) {
  return error && (error.code === "EXPORT_CANCELED" || /Export canceled/i.test(String(error.message || "")));
}

function publicItem(item) {
  return {
    id: item.id,
    batchId: item.batchId,
    assetId: item.assetId,
    label: item.label,
    destination: item.destination,
    state: item.state,
    progress: item.progress,
    error: item.error,
    result: item.result,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt
  };
}

module.exports = { ExportQueue, normalizeConcurrency, isCancelError, QUEUED, RUNNING, DONE, FAILED, CANCELED, TERMINAL };
