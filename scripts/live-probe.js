/**
 * Live preview probe. Drives the running app over CDP and records what the
 * renderer's own clock/frame path actually does during playback.
 *
 * Usage: node scripts/live-probe.js <subcommand>
 *   state           dump device + media list
 *   play <index>    open card <index>, play, sample clock/frame counters
 */
"use strict";

async function connect() {
  const targets = await fetch("http://127.0.0.1:9222/json").then(r => r.json());
  const page = targets.find(t => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params) => new Promise(resolve => {
    const callId = ++id;
    pending.set(callId, resolve);
    ws.send(JSON.stringify({ id: callId, method, params }));
  });
  const evalJs = async expression => {
    const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    const r = reply && reply.result;
    if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception || {}));
    return r && r.result ? r.result.value : null;
  };
  return { ws, evalJs };
}

const STATE = `JSON.stringify({
  device: (document.getElementById('device-title')||{}).textContent,
  cards: [...document.querySelectorAll('.media-card')].map((c,i) => ({ i, text: (c.textContent||'').replace(/\\s+/g,' ').trim().slice(0,70) })),
  error: (document.querySelector('.preview-error, #preview-error')||{}).textContent || null
})`;

// Instrument the real code paths, then play and sample.
const INSTRUMENT = `(() => {
  const w = window;
  if (w.__probe) return "already";
  const pc = w.__previewClock;
  const probe = { decisions: {}, samples: [], frames: 0, firstFrameAt: null, playStartedAt: null };
  w.__probe = probe;
  const origDecision = pc.frameDecision;
  pc.frameDecision = function (input) {
    const out = origDecision.call(this, input);
    probe.frames += 1;
    if (probe.firstFrameAt === null) probe.firstFrameAt = performance.now();
    probe.decisions[out.action] = (probe.decisions[out.action] || 0) + 1;
    if (probe.samples.length < 4000) probe.samples.push({
      t: +(performance.now() / 1000).toFixed(3),
      f: +Number(input && input.frameSourceTime).toFixed(3),
      c: +Number(input && input.clockSourceTime).toFixed(3),
      s: +Number(out.skew).toFixed(4),
      a: out.action
    });
    return out;
  };
  return "ok";
})()`;

async function main() {
  const cmd = process.argv[2] || "state";
  const { ws, evalJs } = await connect();
  if (cmd === "state") {
    console.log(await evalJs(STATE));
    ws.close();
    return;
  }
  if (cmd === "play") {
    const index = Number(process.argv[3] || 0);
    console.log("instrument:", await evalJs(INSTRUMENT));
    const opened = await evalJs(`(() => {
      const cards = document.querySelectorAll('.media-card');
      const card = cards[${index}];
      if (!card) return "no card " + ${index} + " of " + cards.length;
      const target = card.querySelector('.thumb, img, button') || card;
      target.click();
      return "clicked " + (card.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60);
    })()`);
    console.log("open:", opened);
    await new Promise(r => setTimeout(r, 4000));
    console.log("after-open:", await evalJs(`JSON.stringify({
      hasVideo: !!document.querySelector('video'),
      src: ((document.querySelector('video')||{}).src||'').slice(-60),
      badge: (document.getElementById('state-badge')||{}).textContent,
      err: (document.querySelector('.preview-error, #preview-error')||{}).textContent || null
    })`));
    const played = await evalJs(`(async () => {
      const v = document.querySelector('video');
      if (!v) return "no video element";
      window.__probe.playStartedAt = performance.now();
      try { v.currentTime = 0; await v.play(); } catch (e) { return "play failed: " + e.message; }
      return "playing rate=" + v.playbackRate + " dur=" + (v.duration||0).toFixed(3);
    })()`);
    console.log("play:", played);
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 2000));
      console.log("sample:", await evalJs(`(() => {
        const v = document.querySelector('video');
        const p = window.__probe;
        return JSON.stringify({
          videoTime: +(v ? v.currentTime : -1).toFixed(3),
          paused: v ? v.paused : null,
          frames: p.frames,
          decisions: p.decisions,
          err: (document.querySelector('.preview-error, #preview-error')||{}).textContent || null
        });
      })()`));
    }
    const trace = await evalJs(`(() => {
      const p = window.__probe;
      const s = p.samples;
      const step = Math.max(1, Math.floor(s.length / 25));
      const thin = [];
      for (let i = 0; i < s.length; i += step) thin.push(s[i]);
      return JSON.stringify({
        total: s.length,
        firstFrameDelay: p.firstFrameAt !== null && p.playStartedAt !== null
          ? +((p.firstFrameAt - p.playStartedAt) / 1000).toFixed(3) : null,
        decisions: p.decisions,
        trace: thin
      });
    })()`);
    const parsed = JSON.parse(trace);
    console.log("");
    console.log("total frames :", parsed.total);
    console.log("decisions    :", JSON.stringify(parsed.decisions));
    console.log("firstFrameDelay:", parsed.firstFrameDelay, "s");
    console.log("");
    for (const r of parsed.trace) console.log(`  t=${r.t}s frame=${r.f} clock=${r.c} skew=${r.s >= 0 ? "+" : ""}${r.s} ${r.a}`);
    ws.close();
    return;
  }
  ws.close();
  throw new Error("unknown cmd " + cmd);
}

main().catch(e => { console.error(e); process.exit(1); });
