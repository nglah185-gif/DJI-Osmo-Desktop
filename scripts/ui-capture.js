"use strict";
// Capture the app window over CDP so UI changes can be compared against a
// real rendering rather than an imagined one.
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const label = process.argv[2] || "ui";
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
  const send = (method, params) => new Promise(resolve => { const callId = ++id; pending.set(callId, resolve); ws.send(JSON.stringify({ id: callId, method, params })); });

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const data = shot && shot.result && shot.result.data;
  if (!data) throw new Error("capture returned no data");
  const outDir = path.join(__dirname, "..", "artifacts", "ui");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, label + ".png");
  fs.writeFileSync(outPath, Buffer.from(data, "base64"));
  console.log(outPath);
  process.exit(0);
})().catch(error => { console.error("capture failed:", error.message); process.exit(1); });
