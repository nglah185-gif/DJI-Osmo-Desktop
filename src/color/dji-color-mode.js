const fs = require("node:fs/promises");

// ---------------------------------------------------------------------------
// DJI Osmo Action 4 in-file color-mode detection.
//
// Every DJI MP4/MOV carries a private "djmd" (DJI meta) track written at the
// START of the mdat payload. Its first message is a protobuf stream
// (dvtm_ac203.proto). The video-info message (root field 2) contains:
//   field 3 -> submessage { 1: width, 2: height, 3: fps, 5: COLOR_MODE, ... }
//   field 4 -> submessage { 1: 1 }   (present only for D-Log M)
// where COLOR_MODE is 10 for D-Log M and 8 for Standard.
//
// Verified against 4 real camera files (2 independent same-scene pairs):
//   0371 D-Log: [2.3.5]=10, [2.4]={1:1}     0372 Standard: [2.3.5]=8, [2.4]={}
//   0368 D-Log: [2.3.5]=10, [2.4]={1:1}     0367 Standard: [2.3.5]=8, [2.4]={}
// Cross-checked on the full 87-clip card: 78 D-Log M / 9 Standard, matching
// AC002.db digital_effect (1=D-Log M, 0=Standard) for every clip.
// ---------------------------------------------------------------------------

const MAX_SAMPLE_BYTES = 4096;

// ---- minimal protobuf (wire format) helpers --------------------------------
function readVarint(buf, pos) {
  let value = 0;
  for (let i = 0; i < 9; i++) {
    if (pos + i >= buf.length) return null;
    const byte = buf[pos + i];
    value += (byte & 0x7f) * Math.pow(128, i);
    if ((byte & 0x80) === 0) return { value, pos: pos + i + 1 };
  }
  return null;
}

// Parse a message into a list of { field, wire, varint?, bytes? }.
// Wire types 0 (varint) and 2 (length-delimited) are kept; 1/5 are skipped;
// unknown wire types stop parsing (group encodings are never used here).
function parseMessage(buf, start = 0, end = buf.length) {
  const fields = [];
  let pos = start;
  while (pos < end) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag.pos;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value & 7;
    if (field === 0) break;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      if (!v) break;
      fields.push({ field, wire, varint: v.value });
      pos = v.pos;
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      pos = len.pos;
      if (pos + len.value > end) break;
      fields.push({ field, wire, bytes: buf.subarray(pos, pos + len.value) });
      pos += len.value;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      break; // wire 3/4 (deprecated groups) never appear in this stream
    }
  }
  return fields;
}

function findField(fields, fieldNo, wire) {
  for (const f of fields) {
    if (f.field === fieldNo && (wire === undefined || f.wire === wire)) return f;
  }
  return null;
}

// Decode the color mode out of the head of the djmd sample stream.
// Returns "D-Log M" | "Standard" | null (unknown).
function sampleColorMode(sample) {
  const root = parseMessage(sample);
  const videoInfo = findField(root, 2, 2);
  if (!videoInfo) return null;
  const vi = parseMessage(videoInfo.bytes);

  // [2.3.5] - stream-resolution submessage, field 5 = color mode enum.
  let mode5 = null;
  const streamInfo = findField(vi, 3, 2);
  if (streamInfo) {
    const si = parseMessage(streamInfo.bytes);
    const f5 = findField(si, 5, 0);
    if (f5) mode5 = f5.varint;
  }
  // [2.4] - submessage {1:1} present only for D-Log M.
  let mode4 = null; // true = {1:1}, false = empty, null = absent
  const colorInfo = findField(vi, 4, 2);
  if (colorInfo) {
    const ci = parseMessage(colorInfo.bytes);
    mode4 = findField(ci, 1, 0) !== null;
  }

  if (mode5 === 10 || mode4 === true) return "D-Log M";
  if (mode5 === 8 || mode4 === false) return "Standard";
  return null;
}

// Fixed byte windows kept as a secondary signal (the exact protobuf header of
// the color fields as observed on the verified files).
const DLOG_WINDOW = Buffer.from([0x28, 0x0a, 0x30, 0x04, 0x40, 0x01, 0x22, 0x02, 0x08, 0x01]);
const STANDARD_WINDOW = Buffer.from([0x28, 0x08, 0x30, 0x04, 0x40, 0x01, 0x22, 0x00]);

function indexOfWindow(haystack, needle) {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) { match = false; break; }
    if (match) return i;
  }
  return -1;
}

// Detect the color mode from a buffer that starts at the beginning of an MP4.
// Returns { mode, evidence } with mode in { "D-Log M", "Standard", "UNKNOWN" }.
function detectFromBuffer(head) {
  if (!head || head.length < 16) return { mode: "UNKNOWN", evidence: { reason: "buffer-too-small" } };
  // Walk the top-level boxes to find the mdat payload (djmd track is written first).
  let pos = 0, mdatPayload = -1;
  while (pos + 8 <= head.length) {
    let size = head.readUInt32BE(pos);
    const type = head.toString("latin1", pos + 4, pos + 8);
    let header = 8;
    if (size === 1 && pos + 16 <= head.length) {
      size = head.readUInt32BE(pos + 8) * 4294967296 + head.readUInt32BE(pos + 12);
      header = 16;
    } else if (size === 1) break;
    else if (size === 0) size = head.length - pos;
    if (type === "mdat") { mdatPayload = pos + header; break; }
    if (size < header) break;
    pos += size;
  }

  const start = mdatPayload >= 0 ? mdatPayload : 0;
  const end = mdatPayload >= 0 ? Math.min(head.length, mdatPayload + MAX_SAMPLE_BYTES) : head.length;
  const region = head.subarray(start, end);

  const mode = sampleColorMode(region);
  if (mode) {
    return {
      mode,
      evidence: { source: "djmd-protobuf", confidence: "primary", fields: mode === "D-Log M" ? { "2.3.5": 10, "2.4": { "1": 1 } } : { "2.3.5": 8, "2.4": {} } }
    };
  }

  // Fallback: exact header windows observed on verified files.
  const di = indexOfWindow(region, DLOG_WINDOW);
  const si = indexOfWindow(region, STANDARD_WINDOW);
  if (di !== -1 && (si === -1 || di < si)) return { mode: "D-Log M", evidence: { source: "djmd-window", offset: start + di, fields: { "2.3.5": 10, "2.4": { "1": 1 } } } };
  if (si !== -1 && (di === -1 || si < di)) return { mode: "Standard", evidence: { source: "djmd-window", offset: start + si, fields: { "2.3.5": 8, "2.4": {} } } };

  return { mode: "UNKNOWN", evidence: { reason: mdatPayload >= 0 ? "no-color-mode-in-djmd" : "no-mdat-in-head", mdatPayload } };
}

// Detect the DJI color mode for an MP4/MOV file by reading only its head
// (256 KiB default; the djmd track is written at the front so the whole
// decision needs no more than a few KiB).
async function detectDjiColorMode(filePath, options = {}) {
  const fsp = options.fs || fs;
  const headBytes = options.headBytes || 262144;
  let handle = null;
  try {
    handle = await fsp.open(filePath, "r");
    const head = Buffer.alloc(headBytes);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return detectFromBuffer(head.subarray(0, bytesRead));
  } catch (error) {
    return { mode: "UNKNOWN", evidence: { reason: "io-error", message: String(error && error.message || error) } };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

module.exports = { detectFromBuffer, detectDjiColorMode, sampleColorMode, parseMessage, DLOG_WINDOW, STANDARD_WINDOW };
