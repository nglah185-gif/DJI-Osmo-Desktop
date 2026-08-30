const DEFAULT_SCAN_CONCURRENCY = 4;
const MAX_SCAN_CONCURRENCY = 8;

function normalizeConcurrency(value, fallback = DEFAULT_SCAN_CONCURRENCY) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_SCAN_CONCURRENCY, Math.floor(parsed)));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  const count = Math.min(items.length, normalizeConcurrency(concurrency));
  let cursor = 0;
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

module.exports = { DEFAULT_SCAN_CONCURRENCY, MAX_SCAN_CONCURRENCY, normalizeConcurrency, mapWithConcurrency };
