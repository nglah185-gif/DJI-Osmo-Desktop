const fs = require("node:fs");
const db = fs.readFileSync("F:\\MISC\\AC002.db");
console.log("SIZE:", db.length);
console.log("HEAD HEX:", [...db.slice(0, 40)].map(b => b.toString(16).padStart(2, "0")).join(" "));
console.log("HEAD ASCII:", [...db.slice(0, 40)].map(b => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join(""));
const ascii = [];
let cur = [];
for (const b of db) { if (b >= 32 && b < 127) { cur.push(b); } else { if (cur.length >= 4) ascii.push(Buffer.from(cur).toString()); cur = []; } }
if (cur.length >= 4) ascii.push(Buffer.from(cur).toString());
console.log("ASCII STRINGS:", ascii.length);
const keywords = ["fav", "star", "mark", "keep", "collect", "dji", "video", "mp4", "lrf", "aac", "time", "index", "thumb", "id"];
const hits = [];
for (const s of ascii) { const lower = s.toLowerCase(); if (keywords.some(k => lower.includes(k))) hits.push(s); }
console.log("KEYWORD HITS SAMPLE:", hits.slice(0, 120));
const utf16 = [];
let kur = [];
for (let i = 0; i + 1 < db.length; i += 2) { const lo = db[i], hi = db[i + 1]; if (hi === 0 && lo >= 32 && lo < 127) { kur.push(lo); } else { if (kur.length >= 3) utf16.push(Buffer.from(kur).toString()); kur = []; } }
if (kur.length >= 3) utf16.push(Buffer.from(kur).toString());
console.log("UTF16 SAMPLE:", utf16.slice(0, 120));
