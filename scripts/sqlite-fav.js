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
function recordValues(buf, start, maxEnd) { const [hdr, off0] = varint(buf, start); if (hdr <= 0 || off0 + hdr > maxEnd) throw new Error("hdr@" + start); let p = off0; const types = []; while (p < start + hdr) { const [t, q] = varint(buf, p); types.push(t); p = q; } const values = []; for (const t of types) { if (t === 0) { values.push(null); continue; } if (t === 8) { values.push(0); continue; } if (t === 9) { values.push(1); continue; } if (t >= 1 && t <= 6) { let v = 0; for (let i = 0; i < t; i++) v = v * 256 + buf[p + i]; values.push(v); p += t; continue; } if (t === 7) { values.push(buf.readDoubleBE(p)); p += 8; continue; } const isBlob = t >= 12 && t % 2 === 0; const len = isBlob ? (t - 12) / 2 : (t - 13) / 2; values.push(buf.slice(p, p + len).toString("latin1")); p += len; } return values; }
function walkTable(rootPage) { const rows = []; function walk(p) { const off = po(p); const btype = db[off]; if (btype === 0x0A || btype === 0x02) return; const n = db.readUInt16BE(off + 3); let ptr = off + 8; if (btype === 0x05) ptr += 4; for (let i = 0; i < n; i++) { const cellOff = db.readUInt16BE(ptr); ptr += 2; const cellAbs = base(p) + cellOff; if (btype === 0x05) { walk(db.readUInt32BE(cellAbs)); continue; } if (btype !== 0x0D) continue; const [payloadLen, a] = varint(db, cellAbs); const [rowid, b] = varint(db, a); const local = Math.min(payloadLen, usable - 35); if (local < payloadLen) throw new Error("overflow rowid " + rowid); rows.push({ rowid, values: recordValues(db, b, b + payloadLen) }); } } walk(rootPage); return rows; }
const gis = walkTable(6);
console.log("== 收藏(star) 去重 ==");
const favNames = new Set();
for (const r of gis) { const s = Number(r.values[7] || 0); if (s !== 0) { const name = String(r.values[3] || ""); favNames.add(name); } }
const favClips = [...favNames].map(n => n.slice(n.lastIndexOf("/") + 1)).sort();
console.log("唯一收藏条目数:", favClips.length);
console.log("收藏清单:");
for (const n of favClips) console.log("  ", n);
console.log("== 文件类型统计 ==");
const bySub = {}; for (const r of gis) { const k = String(r.values[5] || 0) + "/" + String(r.values[4] || 0); bySub[k] = (bySub[k] || 0) + 1; }
console.log("sub/file_type:", JSON.stringify(bySub));
const vids = walkTable(8);
console.log("== video_info_table ==", vids.length, "rows");
const models = {}, rw = {}, enc = {}, fpsCount = {}, slow = {}, rot = {}, eff = {}; let hl = 0;
for (const v of vids.map(r => r.values)) { const M = String(v[26]); models[M] = (models[M] || 0) + 1; const keyR = String(v[5]) + "x" + String(v[6]); rw[keyR] = (rw[keyR] || 0) + 1; enc[String(v[8])] = (enc[String(v[8])] || 0) + 1; const fr = (Math.round((Number(v[2]) / 1000) * 100) / 100) + "fps"; fpsCount[fr] = (fpsCount[fr] || 0) + 1; const sm = String(Number(v[7]) || 1) + "x"; slow[sm] = (slow[sm] || 0) + 1; rot[String(v[4]) + "deg"] = (rot[String(v[4]) + "deg"] || 0) + 1; eff[String(v[33])] = (eff[String(v[33])] || 0) + 1; if (Number(v[37] || 0) !== 0) hl++; }
console.log("model_name:", JSON.stringify(models));
console.log("分辨率:", JSON.stringify(rw));
console.log("encode_format:", JSON.stringify(enc));
console.log("帧率:", JSON.stringify(fpsCount));
console.log("慢动作倍率:", JSON.stringify(slow));
console.log("rotation:", JSON.stringify(rot));
console.log("digital_effect:", JSON.stringify(eff));
console.log("highlight!=0 视频数:", hl);
const durs = vids.map(r => Number(r.values[1] || 0));
console.log("时长(秒) min/avg/max:", Math.round(Math.min(...durs) / 1000), Math.round(durs.reduce((a, b) => a + b, 0) / durs.length / 1000), Math.round(Math.max(...durs) / 1000));
console.log("时间码范围 sample:", JSON.stringify(vids.slice(0, 3).map(r => [r.values[23], r.values[24]])));
const imgs = walkTable(7);
console.log("== image_info_table ==", imgs.length, "rows(照片索引)");
const mtimes = walkTable(4);
console.log("== mtime_table ==", mtimes.length, "rows");
const vers = walkTable(3);
console.log("== version_table ==", JSON.stringify(vers.map(r => r.values)));
const add = walkTable(9);
console.log("== file_additional_info ==", add.length, "rows; sample:", JSON.stringify(add.slice(0, 6).map(r => r.values)));
const dirs = walkTable(10);
console.log("== dir_additional_info ==", dirs.length, "rows; sample:", JSON.stringify(dirs.slice(0, 6).map(r => r.values)));
fs.unlinkSync(tmp);
