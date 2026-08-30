const fs = require("node:fs");
const path = require("node:path");
(async () => {
  const targets = await fetch("http://127.0.0.1:9222/json").then(r => r.json());
  const page = targets.find(t => t.type === "page");
  if (!page) { console.error("no page target"); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = event => { const msg = JSON.parse(event.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  const send = (method, params) => new Promise(resolve => { const callId = ++id; pending.set(callId, resolve); ws.send(JSON.stringify({ id: callId, method, params })); });
  await new Promise(resolve => ws.onopen = resolve);
  const evalJs = async expression => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return result && result.result ? (result.result.result ? result.result.result.value : result.result) : null; };
  const outline = process.argv.includes("--outline");
  let delay = Number(process.argv[2] || 0);
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  if (outline) { await evalJs("document.querySelectorAll('#media-grid').forEach(e=>{e.style.border='1px solid #f0f'}); true"); await new Promise(r=>setTimeout(r,200)); }
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const out = process.argv.includes("--outline") ? "artifacts/phase3-9-screenshot-outline.png" : "artifacts/phase3-9-screenshot.png";
  fs.mkdirSync(path.join(__dirname, "..", "artifacts"), { recursive: true });
  const file = path.join(__dirname, "..", out);
  fs.writeFileSync(file, Buffer.from(shot.result.data, "base64"));
  const state = await evalJs("JSON.stringify({cards:document.querySelectorAll('.media-card').length,thumbs:document.querySelectorAll('.thumb img').length,device:document.getElementById('device-title').textContent})");
  console.log(JSON.stringify({ file, state: JSON.parse(state) }));
  ws.close();
})().catch(error => { console.error(error); process.exit(1); });
