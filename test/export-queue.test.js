"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ExportQueue, normalizeConcurrency } = require("../src/tasks/export-queue");

// A worker that resolves only when told to, so tests control the interleaving
// instead of racing real timers. It mirrors the real export worker in the one
// way that matters: an abort makes it reject with "Export canceled" rather than
// resolving, which is what exportAtomically does.
function deferredWorker() {
  const calls = [];
  const worker = ({ signal, onProgress }) => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const onAbort = () => reject(new Error("Export canceled"));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    calls.push({ signal, onProgress, resolve, reject });
    return promise;
  };
  return { worker, calls };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

test("concurrency is clamped to a sane range", () => {
  assert.equal(normalizeConcurrency(undefined), 1);
  assert.equal(normalizeConcurrency(0), 1);
  assert.equal(normalizeConcurrency(-5), 1);
  assert.equal(normalizeConcurrency(2), 2);
  assert.equal(normalizeConcurrency(99), 4);
  assert.equal(normalizeConcurrency("nonsense"), 1);
});

test("the default queue runs one export at a time, in insertion order", async () => {
  const queue = new ExportQueue();
  const { worker, calls } = deferredWorker();
  queue.add({ id: "a", run: worker });
  queue.add({ id: "b", run: worker });
  queue.add({ id: "c", run: worker });
  await settle();
  // Measured: a second concurrent transcode gives no throughput gain (35.9s
  // serial vs 36.1s parallel) because the filter graph already saturates every
  // core. The default must therefore be strictly serial.
  assert.equal(calls.length, 1);
  calls[0].resolve({ outputPath: "a.mp4" });
  await settle();
  assert.equal(calls.length, 2);
  calls[1].resolve({ outputPath: "b.mp4" });
  await settle();
  assert.equal(calls.length, 3);
  calls[2].resolve({ outputPath: "c.mp4" });
  await settle();
  assert.deepEqual(queue.list().map(item => item.state), ["done", "done", "done"]);
});

test("an explicit concurrency runs that many workers without exceeding it", async () => {
  const queue = new ExportQueue({ concurrency: 2 });
  const { worker, calls } = deferredWorker();
  for (const id of ["a", "b", "c", "d"]) queue.add({ id, run: worker });
  await settle();
  assert.equal(calls.length, 2);
  calls[0].resolve(null);
  await settle();
  assert.equal(calls.length, 3);
  calls[1].resolve(null);
  await settle();
  assert.equal(calls.length, 4);
});

test("one failed export does not take the rest of the batch with it", async () => {
  const queue = new ExportQueue();
  const seen = [];
  queue.add({ id: "a", run: async () => { seen.push("a"); throw new Error("disk full"); } });
  queue.add({ id: "b", run: async () => { seen.push("b"); return { outputPath: "b.mp4" }; } });
  await settle();
  assert.deepEqual(seen, ["a", "b"]);
  const items = queue.list();
  assert.equal(items[0].state, "failed");
  assert.match(items[0].error, /disk full/);
  assert.equal(items[1].state, "done");
});

test("canceling a queued export prevents it from ever starting", async () => {
  const queue = new ExportQueue();
  const { worker, calls } = deferredWorker();
  queue.add({ id: "a", run: worker });
  queue.add({ id: "b", run: worker });
  await settle();
  assert.equal(queue.cancel("b"), true);
  calls[0].resolve(null);
  await settle();
  assert.equal(calls.length, 1, "the canceled item must not be started");
  assert.equal(queue.get("b").state, "canceled");
});

test("canceling a running export aborts its signal and reports canceled", async () => {
  const queue = new ExportQueue();
  const { worker, calls } = deferredWorker();
  queue.add({ id: "a", run: worker });
  await settle();
  assert.equal(queue.cancel("a"), true);
  assert.equal(calls[0].signal.aborted, true);
  await settle();
  assert.equal(queue.get("a").state, "canceled");
});

test("a late progress callback cannot resurrect a canceled export", async () => {
  const queue = new ExportQueue();
  const { worker, calls } = deferredWorker();
  queue.add({ id: "a", run: worker });
  await settle();
  calls[0].onProgress(40);
  queue.cancel("a");
  // The abort makes the worker reject on its own; this late callback is the
  // race the guard exists for.
  calls[0].onProgress(90);
  await settle();
  const item = queue.get("a");
  assert.equal(item.state, "canceled");
  assert.equal(item.progress, 40, "progress must not advance after cancel");
});

test("progress is monotonic and clamped to 0..100", async () => {
  const queue = new ExportQueue();
  const { worker, calls } = deferredWorker();
  queue.add({ id: "a", run: worker });
  await settle();
  calls[0].onProgress(30);
  calls[0].onProgress(10);
  calls[0].onProgress(150);
  calls[0].onProgress(-5);
  assert.equal(queue.get("a").progress, 100);
});

test("cancelBatch only touches its own batch", async () => {
  const queue = new ExportQueue({ concurrency: 4 });
  const { worker, calls } = deferredWorker();
  queue.add({ id: "a1", batchId: "x", run: worker });
  queue.add({ id: "a2", batchId: "x", run: worker });
  queue.add({ id: "b1", batchId: "y", run: worker });
  await settle();
  const canceled = queue.cancelBatch("x");
  assert.equal(canceled, 2);
  // a1 and a2 abort and reject; b1 belongs to the other batch and must finish
  // normally.
  calls[2].resolve(null);
  await settle();
  assert.deepEqual(queue.listBatch("x").map(item => item.state), ["canceled", "canceled"]);
  assert.deepEqual(queue.listBatch("y").map(item => item.state), ["done"]);
});

test("summarize reports per-state counts and overall progress", async () => {
  const queue = new ExportQueue({ concurrency: 2 });
  const { worker, calls } = deferredWorker();
  queue.add({ id: "a", batchId: "x", run: worker });
  queue.add({ id: "b", batchId: "x", run: worker });
  queue.add({ id: "c", batchId: "x", run: worker });
  await settle();
  calls[0].onProgress(50);
  let summary = queue.summarize("x");
  assert.equal(summary.total, 3);
  assert.equal(summary.running, 2);
  assert.equal(summary.queued, 1);
  assert.equal(summary.active, 3);
  // 50 + 0 + 0 over three items.
  assert.equal(summary.overallProgress, 17);

  // Only two workers exist until one finishes and the third is pumped in.
  calls[0].resolve(null);
  await settle();
  calls[1].resolve(null);
  await settle();
  calls[2].resolve(null);
  await settle();
  summary = queue.summarize("x");
  assert.equal(summary.done, 3);
  assert.equal(summary.active, 0);
  assert.equal(summary.overallProgress, 100);
});

test("every terminal state marks the item finished so the dialog can close", async () => {
  const queue = new ExportQueue({ concurrency: 3 });
  queue.add({ id: "ok", run: async () => ({ outputPath: "ok.mp4" }) });
  queue.add({ id: "bad", run: async () => { throw new Error("nope"); } });
  queue.add({ id: "skip", run: async () => new Promise(() => {}) });
  await settle();
  queue.cancel("skip");
  await settle();
  const summary = queue.summarize();
  assert.equal(summary.active, 0);
  for (const item of queue.list()) assert.ok(item.finishedAt, item.id + " should have finishedAt");
});

test("an item without a worker fails loudly instead of hanging the queue", async () => {
  const queue = new ExportQueue();
  queue.add({ id: "empty", run: null });
  await settle();
  assert.equal(queue.get("empty").state, "failed");
  assert.match(queue.get("empty").error, /no worker/);
});

test("duplicate ids are rejected so two exports cannot share one slot", () => {
  const queue = new ExportQueue();
  queue.add({ id: "dup", run: async () => null });
  assert.throws(() => queue.add({ id: "dup", run: async () => null }), /Duplicate/);
});

test("prune drops the oldest finished items and keeps active ones", async () => {
  const queue = new ExportQueue({ concurrency: 4 });
  for (let index = 0; index < 5; index++) queue.add({ id: "i" + index, run: async () => null });
  queue.add({ id: "never", run: async () => new Promise(() => {}) });
  await settle();
  assert.equal(queue.prune(2), 3);
  const remaining = queue.list().map(item => item.id);
  assert.equal(remaining.length, 3);
  assert.ok(remaining.includes("never"), "an active item must never be pruned");
});
