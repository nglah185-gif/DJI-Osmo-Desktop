"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const state = require("../src/renderer/batch-export-state");

function starting(names = ["a.mp4", "b.mp4", "c.mp4"]) {
  return state.initialState({
    batchId: "batch-1",
    destination: "C:\\out",
    items: names.map((name, index) => ({ itemId: "batch-1:asset" + index, assetId: "asset" + index, name, outputPath: "C:\\out\\" + name }))
  });
}

function queueItem(index, patch = {}) {
  return { id: "batch-1:asset" + index, state: "running", progress: 0, error: "", ...patch };
}

test("every selected clip is listed immediately, before the queue reports anything", () => {
  const view = state.view(starting());
  assert.equal(view.items.length, 3);
  assert.deepEqual(view.items.map(item => item.state), ["queued", "queued", "queued"]);
  assert.equal(view.settled, false);
  assert.equal(view.cancelHidden, false);
  assert.equal(view.closeHidden, true);
});

test("a queued row shows no percentage instead of a stalled zero", () => {
  const view = state.view(starting());
  assert.equal(view.items[0].percentText, "");
  assert.equal(view.items[0].indeterminate, false);
  assert.equal(view.items[0].statusKey, "batchExport.queued");
});

test("queue updates merge by id and drive the row state", () => {
  let current = starting();
  current = state.applyQueueUpdate(current, [
    queueItem(0, { state: "done", progress: 100 }),
    queueItem(1, { state: "running", progress: 42 }),
    queueItem(2, { state: "queued", progress: 0 })
  ]);
  const view = state.view(current);
  assert.deepEqual(view.items.map(item => item.state), ["done", "running", "queued"]);
  assert.equal(view.items[1].percentText, "42%");
  assert.equal(view.items[1].barWidth, "42%");
  assert.equal(view.items[0].barWidth, "100%");
  assert.equal(view.counts.done, 1);
  assert.equal(view.counts.active, 2);
});

test("a running row with no progress yet is indeterminate, not frozen at zero", () => {
  let current = starting(["a.mp4"]);
  current = state.applyQueueUpdate(current, [queueItem(0, { state: "running", progress: 0 })]);
  assert.equal(state.view(current).items[0].indeterminate, true);
});

test("overall progress is the mean across the whole selection", () => {
  let current = starting();
  current = state.applyQueueUpdate(current, [
    queueItem(0, { state: "done", progress: 100 }),
    queueItem(1, { state: "running", progress: 50 }),
    queueItem(2, { state: "queued", progress: 0 })
  ]);
  assert.equal(state.view(current).overallPercent, 50);
  assert.equal(state.view(current).summaryText, "1/3");
});

test("updates for items outside this batch are ignored, not appended", () => {
  // The queue is shared across batches, so its snapshot carries older work. The
  // dialog must not grow to show clips the user did not select.
  let current = starting(["a.mp4"]);
  current = state.applyQueueUpdate(current, [
    queueItem(0, { state: "done", progress: 100 }),
    { id: "batch-0:someone-else", state: "running", progress: 10 }
  ]);
  assert.equal(current.items.length, 1);
});

test("an unchanged update returns the same object so the DOM is not repainted", () => {
  let current = starting(["a.mp4"]);
  current = state.applyQueueUpdate(current, [queueItem(0, { state: "running", progress: 30 })]);
  const again = state.applyQueueUpdate(current, [queueItem(0, { state: "running", progress: 30 })]);
  assert.equal(again, current, "identical updates must be referentially equal");
  const moved = state.applyQueueUpdate(current, [queueItem(0, { state: "running", progress: 31 })]);
  assert.notEqual(moved, current);
});

test("progress is clamped and rounded into 0..100", () => {
  let current = starting(["a.mp4"]);
  current = state.applyQueueUpdate(current, [queueItem(0, { state: "running", progress: 140.6 })]);
  assert.equal(current.items[0].progress, 100);
  current = state.applyQueueUpdate(current, [queueItem(0, { state: "running", progress: -3 })]);
  assert.equal(current.items[0].progress, 0);
  current = state.applyQueueUpdate(current, [queueItem(0, { state: "running", progress: 41.4 })]);
  assert.equal(current.items[0].progress, 41);
  // Monotonicity is NOT enforced here on purpose: the queue already guarantees
  // it (see the export-queue progress test), and duplicating the rule in the
  // view layer would hide a queue regression instead of surfacing it.
});

test("a clean batch settles as complete and offers only close", () => {
  let current = starting(["a.mp4", "b.mp4"]);
  current = state.applyQueueUpdate(current, [
    queueItem(0, { state: "done", progress: 100 }),
    queueItem(1, { state: "done", progress: 100 })
  ]);
  const view = state.view(current);
  assert.equal(view.settled, true);
  assert.equal(view.headlineKey, "batchExport.complete");
  assert.equal(view.cancelHidden, true);
  assert.equal(view.closeHidden, false);
  assert.equal(view.revealHidden, false);
});

test("a partial failure is reported as partial, never as success", () => {
  let current = starting(["a.mp4", "b.mp4"]);
  current = state.applyQueueUpdate(current, [
    queueItem(0, { state: "done", progress: 100 }),
    queueItem(1, { state: "failed", progress: 40, error: "disk full" })
  ]);
  const view = state.view(current);
  assert.equal(view.headlineKey, "batchExport.partial");
  assert.equal(view.counts.failed, 1);
  // The failing row keeps its message so the user can act on it.
  assert.equal(view.items[1].failed, true);
  assert.equal(view.items[1].errorMessage, "disk full");
  assert.equal(view.items[1].statusKey, "batchExport.failed");
});

test("a batch where everything failed says so instead of looking empty", () => {
  let current = starting(["a.mp4", "b.mp4"]);
  current = state.applyQueueUpdate(current, [
    queueItem(0, { state: "failed", error: "nope" }),
    queueItem(1, { state: "failed", error: "nope" })
  ]);
  const view = state.view(current);
  assert.equal(view.headlineKey, "batchExport.allFailed");
  assert.equal(view.counts.failed, 2);
});

test("fully canceled batches settle and do not offer reveal", () => {
  let current = starting(["a.mp4", "b.mp4"]);
  current = state.applyQueueUpdate(current, [
    queueItem(0, { state: "canceled" }),
    queueItem(1, { state: "canceled" })
  ]);
  const view = state.view(current);
  assert.equal(view.settled, true);
  assert.equal(view.headlineKey, "batchExport.canceled");
  assert.equal(view.revealHidden, true, "nothing was written, so there is nothing to reveal");
  assert.equal(view.closeHidden, false);
});

test("an empty batch is settled rather than stuck", () => {
  const view = state.view(state.initialState({}));
  assert.equal(view.settled, true);
  assert.equal(view.counts.total, 0);
});

test("an unknown queue state falls back to queued instead of breaking the row", () => {
  let current = starting(["a.mp4"]);
  current = state.applyQueueUpdate(current, [{ id: "batch-1:asset0", state: "wat", progress: 5 }]);
  assert.equal(current.items[0].state, "queued");
});
