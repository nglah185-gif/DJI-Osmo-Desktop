const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Every thumbnail decode gets a deadline. A corrupt or truncated file can wedge
// ffmpeg indefinitely, and because the loader only allows a few decodes at once,
// three such files would stall the whole thumbnail pipeline with no error to
// show for it. Resolve false on the deadline so the next source is tried.
function run(command, args, timeoutMs = 15000) {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
    let settled = false;
    let timer = null;
    const finish = ok => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(ok); };
    timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(false); }, Math.max(250, Number(timeoutMs) || 15000));
    child.on("error", () => finish(false));
    child.on("close", code => finish(code === 0));
  });
}
function copyIfExists(source, target) { try { fs.copyFileSync(source, target); return true; } catch { return false; } }
function signatureOf(p) { try { const s = fs.statSync(p); return Math.round(s.mtimeMs) + "-" + s.size; } catch { return ""; } }

// Width of a JPEG, read from its own header rather than decoded.
//
// DJI writes two companions into MISC/THM/<folder>/: a 160x90 .THM at about
// 2 KB and a 1280x720 .SCR at about 500 KB. The old chain always preferred the
// THM, which was correct while the list drew 116x72 tiles but left the poster
// grid upscaling a 160px image into 231px. Reading the header costs a few bytes
// of file I/O and lets the caller pick a source that actually covers the tile.
function jpegSize(filePath) {
  let handle = null;
  try {
    handle = fs.openSync(filePath, "r");
    const header = Buffer.alloc(2);
    if (fs.readSync(handle, header, 0, 2, 0) < 2) return null;
    if (header[0] !== 0xff || header[1] !== 0xd8) return null;
    let offset = 2;
    // 9 bytes covers a marker, its length, and a Start-Of-Frame payload:
    //   FF <marker> | length(2) | precision(1) | height(2) | width(2)
    const segment = Buffer.alloc(9);
    while (offset < 1 << 20) {
      if (fs.readSync(handle, segment, 0, 9, offset) < 4) return null;
      if (segment[0] !== 0xff) return null;
      const marker = segment[1];
      // SOF0..SOF15 carry the frame dimensions. DHT, JPG and DAC are not frame
      // headers despite sharing the 0xC0-0xCF range.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = segment.readUInt16BE(5);
        const width = segment.readUInt16BE(7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      // Standalone markers carry no length field.
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = segment.readUInt16BE(2);
      if (length < 2) return null;
      offset += 2 + length;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (handle !== null) { try { fs.closeSync(handle); } catch {} }
  }
}

// EXIF orientation of a JPEG, read from its own header. 1 means "as stored";
// anything else means the pixels have to be rotated or mirrored to look right.
// Only IFD0 is read, because that is the only place the tag lives.
function jpegOrientation(filePath) {
  let handle = null;
  try {
    handle = fs.openSync(filePath, "r");
    const header = Buffer.alloc(2);
    if (fs.readSync(handle, header, 0, 2, 0) < 2) return null;
    if (header[0] !== 0xff || header[1] !== 0xd8) return null;
    let offset = 2;
    const segment = Buffer.alloc(9);
    while (offset < 1 << 20) {
      if (fs.readSync(handle, segment, 0, 9, offset) < 4) return null;
      if (segment[0] !== 0xff) return null;
      const marker = segment[1];
      if (marker === 0xda || marker === 0xd9) return 1;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = segment.readUInt16BE(2);
      if (length < 2) return null;
      if (marker === 0xe1) {
        const payload = Buffer.alloc(Math.min(length - 2, 4096));
        const read = fs.readSync(handle, payload, 0, payload.length, offset + 4);
        if (read >= 14 && payload.toString("latin1", 0, 6) === "Exif\0\0") {
          const tiff = payload.subarray(6, read);
          const little = tiff[0] === 0x49;
          const u16 = o => little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o);
          const u32 = o => little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o);
          if (u16(2) === 0x002a) {
            const ifd0 = u32(4);
            const count = u16(ifd0);
            for (let index = 0; index < count; index++) {
              const entry = ifd0 + 2 + index * 12;
              if (entry + 12 > tiff.length) break;
              if (u16(entry) === 0x0112) {
                const value = u16(entry + 8);
                return value >= 1 && value <= 8 ? value : 1;
              }
            }
          }
        }
        return 1;
      }
      offset += 2 + length;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (handle !== null) { try { fs.closeSync(handle); } catch {} }
  }
}

// DJI writes a .THM and a .SCR beside every still, but neither carries the EXIF
// orientation. Copying them is what put a portrait shot on its side in the grid
// while the preview -- which decodes the original -- showed it upright. A
// rotated still therefore cannot be served from its companions at all.
function isRotatedStill(filePath) {
  if (!filePath || !/\.jpe?g$/i.test(filePath)) return false;
  const orientation = jpegOrientation(filePath);
  return orientation !== null && orientation > 1;
}

// The cache key has to follow the source that actually produced an entry: a
// rotated still is generated from the original, everything else comes from the
// companion. Keeping one key for both would serve the old sideways copy from
// the cache forever.
function thumbnailSignature({ thmPath = null, scrPath = null, originalPath = null } = {}) {
  if (isRotatedStill(originalPath)) return signatureOf(originalPath) || signatureOf(thmPath || scrPath);
  return signatureOf(thmPath || scrPath) || signatureOf(originalPath);
}

// ffmpeg autorotates a JPEG on the way in, so scaling the original is all it
// takes to get an upright tile at the size the grid asked for.
function stillThumbnailArgs(inputPath, output, minWidth) {
  const args = ["-y", "-v", "error", "-i", inputPath, "-frames:v", "1", "-q:v", "3"];
  const width = Math.round(Number(minWidth) || 0);
  if (width > 0) args.push("-vf", "scale=" + width + ":-2");
  args.push(output);
  return args;
}

// A source is usable when it covers the tile, or when its size cannot be read.
// An unreadable header should not cost the user their thumbnail.
function covers(candidate, minWidth) {
  if (!(Number(minWidth) > 0)) return true;
  const size = jpegSize(candidate);
  return size ? size.width >= Number(minWidth) : true;
}

// The cache key carries the requested width: the same asset legitimately
// resolves to the THM for the list and the SCR for the poster grid, and they
// must not overwrite each other.
//
// The id is sanitized because a local-library id is a path and carries a colon.
// Written into a filename verbatim that becomes an NTFS alternate data stream
// ("local" plus a hidden stream), so the file looks cached while the real bytes
// are invisible to a normal read.
function cacheName(assetId, sourceSignature, minWidth) {
  const safe = String(assetId || "asset").replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_").replace(/[. ]+$/g, "") || "asset";
  return safe + (sourceSignature ? "-" + sourceSignature : "") + (Number(minWidth) > 0 ? "-w" + Number(minWidth) : "") + ".jpg";
}

// Grid thumbnail chain, in two passes.
//
// Pass one takes the first source that actually covers the requested tile width,
// in preference order THM -> SCR -> still original. Pass two decodes a frame,
// which is always full size. Pass three falls back to a source that exists but
// is smaller than asked for: a slightly soft tile is much better than an empty
// one, and this only happens on a card that has no SCR beside its THM.
async function ensureThumbnail({ ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", assetId, previewPath, originalPath, thmPath = null, scrPath = null, cacheRoot, minWidth = 0 }) {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const signature = thumbnailSignature({ thmPath, scrPath, originalPath });
  const output = path.join(cacheRoot, cacheName(assetId, signature, minWidth));
  if (fs.existsSync(output)) return output;

  const copies = [thmPath, scrPath].filter(Boolean);
  if (isRotatedStill(originalPath)) {
    if (await run(ffmpeg, stillThumbnailArgs(originalPath, output, minWidth))) return output;
    // Without a decoder the original is still the only source that carries the
    // orientation, so a large upright tile beats a small sideways one.
    if (copyIfExists(originalPath, output)) return output;
  }
  for (const source of copies) if (covers(source, minWidth) && copyIfExists(source, output)) return output;
  if (originalPath && /\.(?:jpe?g|png)$/i.test(originalPath) && copyIfExists(originalPath, output)) return output;

  if (previewPath) {
    if (await run(ffmpeg, ["-y", "-v", "error", "-i", previewPath, "-map", "0:v:1", "-frames:v", "1", "-q:v", "3", output])) return output;
    if (await run(ffmpeg, ["-y", "-v", "error", "-ss", "0.5", "-i", previewPath, "-map", "0:v:0", "-frames:v", "1", "-q:v", "3", output])) return output;
  }
  if (originalPath && await run(ffmpeg, ["-y", "-v", "error", "-ss", "0.5", "-i", originalPath, "-frames:v", "1", "-q:v", "3", output])) return output;

  // Last resort: everything above failed, so take whatever companion exists even
  // though it is undersized.
  for (const source of copies) if (copyIfExists(source, output)) return output;
  return null;
}

// Poster chain for selected media: SCR -> LRF attached -> LRF first frame -> Original first frame -> null.
async function ensurePoster({ ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", assetId, previewPath, originalPath, scrPath = null, posterRoot }) {
  fs.mkdirSync(posterRoot, { recursive: true });
  const signature = thumbnailSignature({ scrPath, originalPath });
  const output = path.join(posterRoot, cacheName(assetId, signature));
  if (fs.existsSync(output)) return output;
  if (isRotatedStill(originalPath)) {
    if (await run(ffmpeg, stillThumbnailArgs(originalPath, output, 0))) return output;
    if (copyIfExists(originalPath, output)) return output;
  }
  if (scrPath && copyIfExists(scrPath, output)) return output;
  if (originalPath && /\.(?:jpe?g|png)$/i.test(originalPath) && copyIfExists(originalPath, output)) return output;
  if (previewPath) {
    if (await run(ffmpeg, ["-y", "-v", "error", "-i", previewPath, "-map", "0:v:1", "-frames:v", "1", "-q:v", "3", output])) return output;
    if (await run(ffmpeg, ["-y", "-v", "error", "-ss", "0.5", "-i", previewPath, "-map", "0:v:0", "-frames:v", "1", "-q:v", "3", output])) return output;
  }
  if (originalPath && await run(ffmpeg, ["-y", "-v", "error", "-ss", "0.5", "-i", originalPath, "-frames:v", "1", "-q:v", "3", output])) return output;
  return null;
}

function placeholderState(hasPreview) { return { kind: "PLACEHOLDER", label: hasPreview ? "NO_THUMBNAIL" : "PREVIEW_UNAVAILABLE" }; }

function resolveCachePath({ assetId, thmPath = null, scrPath = null, originalPath = null, cacheRoot, minWidth = 0 }) { const signature = thumbnailSignature({ thmPath, scrPath, originalPath }); return path.join(cacheRoot, cacheName(assetId, signature, minWidth)); }

module.exports = { ensureThumbnail, ensurePoster, placeholderState, resolveCachePath, jpegSize, jpegOrientation, isRotatedStill, thumbnailSignature, covers, cacheName };
