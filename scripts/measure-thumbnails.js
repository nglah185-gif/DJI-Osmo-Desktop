const fs = require("node:fs");
const path = require("node:path");
(async () => {
  const targets = await fetch("http://127.0.0.1:9222/json").then(r => r.json());
  const page = targets.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = event => { const msg = JSON.parse(event.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  const send = (method, params) => new Promise(resolve => { const callId = ++id; pending.set(callId, resolve); ws.send(JSON.stringify({ id: callId, method, params })); });
  await new Promise(resolve => ws.onopen = resolve);
  const evalJs = async expression => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return result && result.result ? (result.result.result ? result.result.result.value : result.result) : null; };
  const t0 = Date.now();
  const samples = [];
  let peakLoading = 0;
  for (let i = 0; i < 40; i++) {
    const s = await evalJs("JSON.stringify((() => { const el = document.getElementById('thumb-stats'); return { stats: el ? el.textContent : null, thumbs: document.querySelectorAll('.thumb img').length, cards: document.querySelectorAll('.media-card').length, heapMB: Math.round((performance.memory && performance.memory.usedJSHeapSize || 0) / 1048576) }; })())");
    samples.push({ at: Date.now() - t0, ...JSON.parse(s) });
    const m = /Loading: (\d+)/.exec(samples[samples.length - 1].stats || "");
    if (m) peakLoading = Math.max(peakLoading, Number(m[1]));
    await new Promise(r => setTimeout(r, 150));
  }
  const firstThumb = samples.findIndex(s => s.thumbs > 0);
  const allLoaded = samples.findIndex(s => Number((/Loaded: (\d+)/.exec(s.stats || "") || [])[1] || 0) + Number((/Cache Hit: (\d+)/.exec(s.stats || "") || [])[1] || 0) >= Number((/Visible: (\d+)/.exec(s.stats || "") || [])[1] || 0) && s.thumbs > 0);
  const fps = await evalJs("(async () => { const g = document.getElementById('media-grid'); let frames = 0; const started = performance.now(); const tick = () => { frames++; if (performance.now() - started < 1000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); await new Promise(r => setTimeout(r, 1100)); return frames; })()");
  const stats = await evalJs("document.getElementById('thumb-stats').textContent");
  const poster = await evalJs("JSON.stringify({ hidden: document.getElementById('poster-preview').hidden, src: document.getElementById('poster-preview').src.slice(0, 50) })");
  const result = { initialRenderMs: samples[0] ? samples[0].at : null, firstVisibleThumbnailMs: firstThumb >= 0 ? samples[firstThumb].at : null, visibleThumbnailCompletionMs: allLoaded >= 0 ? samples[allLoaded].at : null, peakConcurrentLoading: peakLoading, scrollFps: fps, finalStats: stats, poster: JSON.parse(poster), cacheDir: path.join(process.env.APPDATA || "", "dji-osmo-desktop-v2", "cache") };
  fs.writeFileSync(path.join(__dirname, "..", "artifacts", "thumbnail-benchmark.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  ws.close();
})().catch(e => { console.error(e); process.exit(1); });
