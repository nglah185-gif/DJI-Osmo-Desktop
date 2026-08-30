(function () {
class ThumbScheduler {
  constructor(options) { const opts = options || {}; this.concurrency = Math.max(1, Number(opts.concurrency) || 3); this.active = 0; this.queue = []; this.activeTokens = new Set(); this.stats = { requested: 0, started: 0, loaded: 0, error: 0, cacheHit: 0 }; }
  enqueue(task) {
    if (typeof task !== "function") throw new Error("task must be a function");
    const token = task.token || null;
    if (token && (this.activeTokens.has(token) || this.queue.some(item => item.token === token))) return false;
    this.queue.push({ task, priority: Number(task.priority) || 0, token });
    this.stats.requested++;
    this.pump();
    return true;
  }
  pump() { while (this.active < this.concurrency && this.queue.length) { this.queue.sort((a, b) => b.priority - a.priority); const item = this.queue.shift(); if (item.token) this.activeTokens.add(item.token); this.active++; this.stats.started++; Promise.resolve().then(item.task).then(result => { if (result && result.cacheHit) this.stats.cacheHit++; else this.stats.loaded++; if (item.token) this.activeTokens.delete(item.token); this.active--; this.pump(); }).catch(() => { this.stats.error++; if (item.token) this.activeTokens.delete(item.token); this.active--; this.pump(); }); } }
  cancelBelow(minPriority) { const kept = this.queue.filter(item => item.priority >= minPriority); this.stats.requested -= (this.queue.length - kept.length); this.queue = kept; }
  snapshot() { return { ...this.stats, loading: this.active, active: this.active, queued: this.queue.length }; }
  reset() { this.stats = { requested: 0, started: 0, loaded: 0, error: 0, cacheHit: 0 }; this.queue = []; this.active = 0; this.activeTokens.clear(); }
}
if (typeof module !== "undefined" && module.exports) { module.exports = { ThumbScheduler }; } else if (typeof window !== "undefined") { window.__ThumbScheduler = ThumbScheduler; }
})();
