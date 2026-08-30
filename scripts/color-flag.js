const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tmp = path.join(os.tmpdir(), "AC002_readonly.db");
fs.copyFileSync("F:\\MISC\\AC002.db", tmp);
const db = fs.readFileSync(tmp);
const pageSize = db.readUInt16BE(16) || 65536; const usable = pageSize - db[20];
const po = p => (p === 1 ? 100 : (p - 1) * pageSize);
const base = p => (p === 1 ? 0 : (p - 1) * pageSize);
function varint(buf, off) { let v = 0; for (let i = 0; i < 9; i++) { const b = buf[off + i]; if (i === 8) { off += 9; return [v * 256 + b, off]; } v = (v << 7) | (b & 0x7f); off++; if ((b & 0x80) === 0) return [v, off]; } throw new Error("varint"); }
function recordValues(buf, start, maxEnd) { const [hdr, off0] = varint(buf, start); let p = off0; const types = []; while (p < start + hdr) { const [t, q] = varint(buf, p); types.push(t); p = q; } const values = []; for (const t of types) { if (t === 0) { values.push(null); continue; } if (t === 8) { values.push(0); continue; } if (t === 9) { values.push(1); continue; } if (t >= 1 && t <= 6) { let v = 0; for (let i = 0; i < t; i++) v = v * 256 + buf[p + i]; values.push(v); p += t; continue; } if (t === 7) { values.push(buf.readDoubleBE(p)); p += 8; continue; } const isBlob = t >= 12 && t % 2 === 0; const len = isBlob ? (t - 12) / 2 : (t - 13) / 2; values.push(buf.slice(p, p + len).toString("latin1")); p += len; } return values; }
function walkTable(rootPage) { const rows = []; function walk(p) { const off = po(p); const btype = db[off]; if (btype === 0x0A || btype === 0x02) return; const n = db.readUInt16BE(off + 3); let ptr = off + 8; if (btype === 0x05) ptr += 4; for (let i = 0; i < n; i++) { const cellOff = db.readUInt16BE(ptr); ptr += 2; const cellAbs = base(p) + cellOff; if (btype === 0x05) { walk(db.readUInt32BE(cellAbs)); continue; } if (btype !== 0x0D) continue; const [payloadLen, a] = varint(db, cellAbs); const [rowid, b2] = varint(db, a); rows.push({ rowid, values: recordValues(db, b2, b2 + payloadLen) }); } } walk(rootPage); return rows; }
const gis = walkTable(6);
const nameByVideoIndex = {}; for (const r of gis) { const vi = r.values[10]; const nm = r.values[3]; if (vi && nm) { const baseName = nm.slice(nm.lastIndexOf("/") + 1); if (!nameByVideoIndex[vi]) nameByVideoIndex[vi] = baseName; } }
const vids = walkTable(8);
const colorFlags = {}; let count0 = 0, count1 = 0, count2 = 0, countOther = 0;
const sample = [];
for (const r of vids) { const v = r.values; const de = Number(v[33] || 0); const venc = Number(v[25] || 0); const enc = Number(v[8] || 0); const sm = Number(v[7] || 1); if (de === 0) count0++; else if (de === 1) count1++; else if (de === 2) count2++; else countOther++; const key = "de=" + de + "/venc=" + venc + "/enc=" + enc + "/sm=" + sm; colorFlags[key] = (colorFlags[key] || 0) + 1; if (sample.length < 12) sample.push({ videoIndex: r.rowid, name: nameByVideoIndex[r.rowid] || "?", digital_effect: de, venc_type: venc, encode_format: enc, slowmotion_rate: sm, highlight: v[37] }); }
console.log("digital_effect 0/1/2/other:", count0, count1, count2, countOther);
console.log("flags:", JSON.stringify(colorFlags));
console.log("sample:", JSON.stringify(sample, null, 0));
fs.unlinkSync(tmp);
