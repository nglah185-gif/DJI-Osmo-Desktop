const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanLocalDirectory, fingerprint, geometry } = require("../src/local-library/local-scanner");
const { expandSelectedFiles, key: localPathKey } = require("../src/local-library/selected-files");
const { normalizePathList, addSource, removeSource, isPathInside, sourceSnapshot } = require("../src/local-library/source-config");
const { InMemoryMediaCatalog, findAssetInCatalogs } = require("../src/catalog/in-memory-media-catalog");
const fixture = path.join(__dirname, "..", "..", "dji-test-media");
test("scanner finds local videos with unified asset shape and stable fingerprint", async () => {
  const scan = await scanLocalDirectory(fixture, { probe: async function(file) { const lrf = path.extname(file).toLowerCase() === ".lrf"; return { codec: lrf ? "h264" : "hevc", duration: 1, width: lrf ? 1280 : 1920, height: lrf ? 720 : 1080, fps: { value: 29.97 } }; } });
  const videos = scan.filter(a => a.original.extension === "mp4");
  assert.ok(videos.length >= 4);
  const clip = videos.find(a => a.original.name === "普通色彩.MP4");
  assert.ok(clip.id.startsWith("local:"));
  assert.equal(clip.preview.name, "普通色彩.LRF");
  assert.equal(clip.captureMode, "STANDARD");
  assert.equal(clip.thumbnail.kind, "attached-jpeg");
  const stat = fs.statSync(path.join(fixture, "普通色彩.MP4"));
  assert.equal(clip.id.slice(6), fingerprint(path.join(fixture, "普通色彩.MP4"), stat));
});
test("scanner only collects video extensions", async () => {
  const scan = await scanLocalDirectory(fixture, {});
  assert.equal(scan.some(a => a.original.extension === "lrf"), false);
  assert.equal(scan.some(a => a.original.extension === "aac"), false);
});

test("local scanner pairs LRF and AAC companions without listing them as assets", async () => {
  const scan = await scanLocalDirectory(fixture, { probe: async file => ({ codec: path.extname(file).toLowerCase() === ".aac" ? "aac" : "h264", duration: 1, width: 1280, height: 720 }) });
  assert.equal(scan.length, 4);
  assert.equal(scan.filter(asset => asset.preview !== "UNKNOWN").length, 2);
  assert.equal(scan.filter(asset => asset.externalAudioCandidates.length > 0).length, 2);
  assert.equal(scan.filter(asset => asset.captureMode === "SLOW_MOTION").length, 2);
});

test("unified catalog lookup finds local assets used by thumbnails and posters", () => {
  const camera = new InMemoryMediaCatalog();
  const local = new InMemoryMediaCatalog();
  camera.replace({ assets: [{ id: "camera:1" }] });
  local.replace({ assets: [{ id: "local:1", source: "local" }] });
  assert.equal(findAssetInCatalogs("camera:1", camera, local).id, "camera:1");
  assert.equal(findAssetInCatalogs("local:1", camera, local).id, "local:1");
  assert.equal(findAssetInCatalogs("missing", camera, local), null);
});

test("local display geometry swaps dimensions for rotated portrait originals", () => {
  assert.deepEqual(geometry({ width: 3840, height: 2160, rotation: -90, displayMatrix: "matrix" }), {
    encodedWidth: 3840,
    encodedHeight: 2160,
    displayWidth: 2160,
    displayHeight: 3840,
    rotation: -90,
    displayMatrix: "matrix"
  });
});

test("local scanner bounds probes and preserves discovery order", async () => {
  const names = Array.from({ length: 12 }, (_, index) => "clip-" + index.toString().padStart(2, "0") + ".mp4");
  let active = 0;
  let peak = 0;
  const assets = await scanLocalDirectory("X:\\library", {
    fs: {
      readdir: async () => names.map(name => ({ name, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true })),
      stat: async file => { const index = names.indexOf(path.basename(file)); const mtime = new Date(1700000000000 + index); return { size: 1000 + index, mtime, mtimeMs: mtime.getTime() }; }
    },
    probeConcurrency: 4,
    probe: async file => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 15 - names.indexOf(path.basename(file))));
      active--;
      return { width: 1920, height: 1080 };
    },
    colorModeDetector: async () => ({ mode: "UNKNOWN" })
  });
  assert.equal(peak, 4);
  assert.deepEqual(assets.map(asset => asset.original.name), names);
});

test("local scanner reports concurrent probe errors in discovery order", async () => {
  const names = ["first.mp4", "second.mp4", "third.mp4"];
  const errors = [];
  const assets = await scanLocalDirectory("X:\\library", {
    fs: {
      readdir: async () => names.map(name => ({ name, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true })),
      stat: async () => ({ size: 1, mtime: new Date(0), mtimeMs: 0 })
    },
    probe: async file => {
      await new Promise(resolve => setTimeout(resolve, file.endsWith("first.mp4") ? 20 : 1));
      throw new Error("cannot probe " + path.basename(file));
    },
    onError: error => errors.push(error),
    colorModeDetector: async () => ({ mode: "UNKNOWN" })
  });
  assert.equal(assets.length, 3);
  assert.ok(assets.every(asset => Object.keys(asset.original.probe).length === 0));
  assert.deepEqual(errors.map(error => path.basename(error.path)), names);
});

test("selected file import includes same-stem companions but not neighboring originals", async () => {
  const groups = await expandSelectedFiles(["X:\\clips\\DJI_0001.MP4"], {
    fs: {
      readdir: async () => ["DJI_0001.MP4", "DJI_0001.LRF", "DJI_0001.AAC", "DJI_0002.MP4"].map(name => ({ name, isDirectory: () => false }))
    }
  });
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0].selectedOriginals], [localPathKey("X:\\clips\\DJI_0001.MP4")]);
  assert.deepEqual([...groups[0].allowedPaths].sort(), ["X:\\clips\\DJI_0001.MP4", "X:\\clips\\DJI_0001.LRF", "X:\\clips\\DJI_0001.AAC"].map(localPathKey).sort());
});

test("local scanner allowlist excludes unselected files in the same directory", async () => {
  const selected = new Set(["普通色彩.mp4", "普通色彩.lrf"]);
  const scan = await scanLocalDirectory(fixture, {
    maxDepth: 0,
    includeFile: filePath => selected.has(path.basename(filePath).toLowerCase()),
    probe: async file => ({ codec: path.extname(file).toLowerCase() === ".lrf" ? "h264" : "hevc", duration: 1, width: 1280, height: 720 }),
    colorModeDetector: async () => ({ mode: "UNKNOWN" })
  });
  assert.equal(scan.length, 1);
  assert.equal(scan[0].original.name, "普通色彩.MP4");
  assert.equal(scan[0].preview.name, "普通色彩.LRF");
});

test("local scanner reaches deeply nested local media by default", async () => {
  const entries = new Map([
    [fixture, [{ name: "year", isDirectory: () => true, isSymbolicLink: () => false }]],
    [path.join(fixture, "year"), [{ name: "month", isDirectory: () => true, isSymbolicLink: () => false }]],
    [path.join(fixture, "year", "month"), [{ name: "camera", isDirectory: () => true, isSymbolicLink: () => false }]],
    [path.join(fixture, "year", "month", "camera"), [{ name: "day", isDirectory: () => true, isSymbolicLink: () => false }]],
    [path.join(fixture, "year", "month", "camera", "day"), [{ name: "clip.MP4", isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }]]
  ]);
  const scan = await scanLocalDirectory(fixture, {
    fs: {
      readdir: async current => entries.get(current) || [],
      stat: async () => ({ size: 123, mtime: new Date(0), mtimeMs: 0 })
    },
    probe: async () => ({ codec: "hevc", duration: 1, width: 1920, height: 1080 }),
    colorModeDetector: async () => ({ mode: "UNKNOWN" })
  });
  assert.equal(scan.length, 1);
  assert.equal(scan[0].original.name, "clip.MP4");
});

test("local sources normalize Windows case variants and remove by canonical path", () => {
  assert.deepEqual(normalizePathList(["X:\\Media", "x:\\media", "X:\\Other"]), [path.resolve("X:\\Media"), path.resolve("X:\\Other")]);
  const added = addSource(["X:\\Media"], "x:\\MEDIA");
  assert.equal(added.length, 1);
  assert.deepEqual(removeSource(added, "X:\\media"), []);
});

test("local source containment skips files already covered by a folder", () => {
  assert.equal(isPathInside("X:\\Media\\clip.mp4", "x:\\media"), true);
  assert.equal(isPathInside("X:\\Media 2\\clip.mp4", "X:\\Media"), false);
  assert.deepEqual(sourceSnapshot({ localRoots: ["X:\\Media"], localFiles: ["X:\\clip.mp4"] }), {
    folders: [path.resolve("X:\\Media")], files: [path.resolve("X:\\clip.mp4")]
  });
});
