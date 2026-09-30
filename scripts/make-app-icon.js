"use strict";
// Draws the application icon and writes assets/app-icon.png and
// assets/app-icon.ico. Run it through Electron, which supplies the canvas:
//
//   node_modules\electron\dist\electron.exe scripts\make-app-icon.js
//
// The mark is built for the smallest size first: a dark squircle body (the app's
// stage), one lens with the accent ring, a specular arc and a record dot. Each
// icon size is drawn from the same vector so 16px stays legible.
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const SIZES = [16, 24, 32, 48, 64, 128, 256];

const SVG = `
<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#242a31"/>
      <stop offset="0.55" stop-color="#14171b"/>
      <stop offset="1" stop-color="#0a0c0e"/>
    </linearGradient>
    <radialGradient id="lens" cx="0.38" cy="0.3" r="0.9">
      <stop offset="0" stop-color="#313942"/>
      <stop offset="0.6" stop-color="#111417"/>
      <stop offset="1" stop-color="#060708"/>
    </radialGradient>
    <linearGradient id="ring" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="#8ab6ff"/>
      <stop offset="0.5" stop-color="#4c8dff"/>
      <stop offset="1" stop-color="#2a5fd0"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="62" fill="url(#body)"/>
  <rect x="9" y="9" width="238" height="238" rx="61" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="2"/>
  <circle cx="128" cy="126" r="78" fill="url(#lens)"/>
  <circle cx="128" cy="126" r="78" fill="none" stroke="url(#ring)" stroke-width="9"/>
  <circle cx="128" cy="126" r="57" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="2"/>
  <circle cx="128" cy="126" r="22" fill="rgba(12,16,20,0.92)" stroke="rgba(76,141,255,0.35)" stroke-width="2.5"/>
  <circle cx="128" cy="126" r="9" fill="rgba(76,141,255,0.22)"/>
  <path d="M92 100 A 46 46 0 0 1 134 82" fill="none" stroke="rgba(255,255,255,0.72)" stroke-width="10" stroke-linecap="round"/>
  <circle cx="190" cy="186" r="13" fill="#4c8dff" stroke="#14171b" stroke-width="4"/>
</svg>`;

const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent">
<script>
const svg = ${JSON.stringify(SVG)};
const blob = new Blob([svg], { type: "image/svg+xml" });
const url = URL.createObjectURL(blob);
window.render = sizes => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => {
    const out = sizes.map(size => {
      const canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, 0, 0, size, size);
      return { size, data: canvas.toDataURL("image/png") };
    });
    resolve(out);
  };
  image.onerror = () => reject(new Error("svg failed to load"));
  image.src = url;
});
</script></body>`;

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  const blobs = [];
  let offset = 6 + 16 * images.length;
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.buffer.length;
    entries.push(entry);
    blobs.push(image.buffer);
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 300, height: 300, webPreferences: { offscreen: true } });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(PAGE));
  const rendered = await window.webContents.executeJavaScript(`window.render(${JSON.stringify(SIZES)})`);
  const images = rendered.map(item => ({ size: item.size, buffer: Buffer.from(String(item.data).split(",")[1], "base64") }));
  const target = path.join(__dirname, "..", "assets");
  fs.mkdirSync(target, { recursive: true });
  const largest = images[images.length - 1];
  fs.writeFileSync(path.join(target, "app-icon.png"), largest.buffer);
  fs.writeFileSync(path.join(target, "app-icon.ico"), buildIco(images));
  console.log("wrote", path.join(target, "app-icon.png"), largest.buffer.length, "bytes");
  console.log("wrote", path.join(target, "app-icon.ico"), buildIco(images).length, "bytes", SIZES.join("/"));
  app.exit(0);
}).catch(error => { console.error("FAILED:", error.message); app.exit(1); });
