(() => {
  // Pure state for the batch export dialog. DOM wiring lives in
  // renderer-phase3.js; everything here is reachable from Node so the phase
  // machine and the label formatting stay unit tested.
  //
  // The shape mirrors the main-process export queue: the queue owns scheduling
  // and truth, this owns presentation. A queue update replaces per-item state;
  // nothing here decides when work happens.

  const PENDING = "queued";
  const RUNNING = "running";
  const DONE = "done";
  const FAILED = "failed";
  const CANCELED = "canceled";
  const TERMINAL = new Set([DONE, FAILED, CANCELED]);

  // The dialog is constructed from the queued items before the queue has
  // produced its first update, so every row exists immediately instead of the
  // list appearing one item at a time.
  function initialState({ batchId = null, destination = "", items = [], skipped = 0 } = {}) {
    return {
      batchId: batchId ? String(batchId) : null,
      destination: String(destination || ""),
      // Photos and unreadable entries are dropped before queueing. Surfacing the
      // count keeps a silent drop from looking like the selection was honored.
      skipped: Math.max(0, Number(skipped) || 0),
      items: (Array.isArray(items) ? items : []).map(entry => ({
        id: String(entry.itemId || entry.id || ""),
        assetId: String(entry.assetId || ""),
        name: String(entry.name || ""),
        destination: String(entry.outputPath || entry.destination || ""),
        state: PENDING,
        progress: 0,
        error: ""
      }))
    };
  }

  // Merge a queue snapshot. Unknown ids are ignored rather than appended: the
  // queue may hold items from an earlier batch, and silently growing the dialog
  // would show clips the user did not select this time.
  function applyQueueUpdate(state, queueItems) {
    if (!Array.isArray(queueItems)) return state;
    const byId = new Map(queueItems.map(item => [String(item && item.id), item]));
    let changed = false;
    const items = state.items.map(entry => {
      const update = byId.get(entry.id);
      if (!update) return entry;
      const next = {
        ...entry,
        state: normalizeState(update.state),
        progress: clampPercent(update.progress),
        error: update.error ? String(update.error) : ""
      };
      if (next.state !== entry.state || next.progress !== entry.progress || next.error !== entry.error) changed = true;
      return next;
    });
    return changed ? { ...state, items } : state;
  }

  function normalizeState(value) {
    const text = String(value || "");
    return [PENDING, RUNNING, DONE, FAILED, CANCELED].includes(text) ? text : PENDING;
  }

  function clampPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(100, Math.round(number)));
  }

  function counts(state) {
    const result = { total: state.items.length, queued: 0, running: 0, done: 0, failed: 0, canceled: 0, active: 0, overallProgress: 0 };
    let progressSum = 0;
    for (const item of state.items) {
      if (item.state === PENDING) result.queued++;
      else if (item.state === RUNNING) result.running++;
      else if (item.state === DONE) result.done++;
      else if (item.state === FAILED) result.failed++;
      else if (item.state === CANCELED) result.canceled++;
      if (!TERMINAL.has(item.state)) result.active++;
      progressSum += item.state === DONE ? 100 : item.progress;
    }
    result.overallProgress = result.total ? Math.round(progressSum / result.total) : 0;
    return result;
  }

  // A batch is settled once nothing is queued or running. Canceled items count
  // as settled: the user asked them to stop and they have.
  function isSettled(state) { return counts(state).active === 0; }

  function statusKeyFor(item) {
    if (item.state === RUNNING) return "batchExport.running";
    if (item.state === DONE) return "batchExport.done";
    if (item.state === FAILED) return "batchExport.failed";
    if (item.state === CANCELED) return "batchExport.canceled";
    return "batchExport.queued";
  }

  function view(state) {
    const tally = counts(state);
    const settled = tally.active === 0;
    // Every failure must be visible even after the batch settles, so the
    // headline reports a partial result rather than a clean success.
    const allFailed = tally.total > 0 && tally.failed === tally.total;
    const anyFailed = tally.failed > 0;
    let headlineKey = "batchExport.exporting";
    if (settled) {
      if (allFailed) headlineKey = "batchExport.allFailed";
      else if (anyFailed) headlineKey = "batchExport.partial";
      else if (tally.canceled === tally.total && tally.total > 0) headlineKey = "batchExport.canceled";
      else headlineKey = "batchExport.complete";
    }
    return {
      batchId: state.batchId,
      settled,
      headlineKey,
      headlineParams: { done: tally.done, failed: tally.failed, canceled: tally.canceled, total: tally.total },
      summaryText: tally.done + "/" + tally.total,
      skipped: state.skipped,
      overallPercent: tally.overallProgress,
      overallWidth: tally.overallProgress + "%",
      counts: tally,
      items: state.items.map(item => ({
        id: item.id,
        assetId: item.assetId,
        name: item.name || item.destination,
        destination: item.destination,
        state: item.state,
        statusKey: statusKeyFor(item),
        percentText: item.state === PENDING ? "" : Math.round(item.progress) + "%",
        // A queued row has no percentage yet; showing a determinate bar at 0
        // would look stalled rather than waiting its turn.
        barWidth: item.state === DONE ? "100%" : clampPercent(item.progress) + "%",
        indeterminate: item.state === RUNNING && item.progress <= 0,
        failed: item.state === FAILED,
        errorMessage: item.error
      })),
      // Cancel stays available while anything is still queued or running.
      cancelHidden: settled,
      closeHidden: !settled,
      revealHidden: settled && tally.done > 0 ? false : true
    };
  }

  const api = { PENDING, RUNNING, DONE, FAILED, CANCELED, TERMINAL, initialState, applyQueueUpdate, counts, isSettled, statusKeyFor, view };
  if (typeof window !== "undefined") window.__batchExportState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
