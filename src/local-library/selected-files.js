"use strict";

const path = require("node:path");

const IMPORTABLE_EXTS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".jpg", ".jpeg", ".png"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".mkv"]);
const COMPANION_EXTS = new Set([".lrf", ".aac"]);

function key(filePath) {
  return path.normalize(filePath).toLowerCase();
}

async function expandSelectedFiles(filePaths, options = {}) {
  const fs = options.fs || require("node:fs/promises");
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  const selected = new Map();
  for (const filePath of Array.isArray(filePaths) ? filePaths : []) {
    if (typeof filePath !== "string" || !IMPORTABLE_EXTS.has(path.extname(filePath).toLowerCase())) continue;
    selected.set(key(filePath), path.normalize(filePath));
  }

  const byDirectory = new Map();
  for (const filePath of selected.values()) {
    const root = path.dirname(filePath);
    const rootKey = key(root);
    if (!byDirectory.has(rootKey)) byDirectory.set(rootKey, { root, selectedOriginals: new Set(), allowedPaths: new Set() });
    const group = byDirectory.get(rootKey);
    group.selectedOriginals.add(key(filePath));
    group.allowedPaths.add(key(filePath));
  }

  for (const group of byDirectory.values()) {
    let entries;
    try { entries = await fs.readdir(group.root, { withFileTypes: true }); }
    catch (error) { onError({ path: group.root, message: error.message }); continue; }
    const names = new Map();
    for (const entry of entries) if (!entry.isDirectory || !entry.isDirectory()) names.set(String(entry.name).toLowerCase(), entry.name);
    for (const selectedPath of group.selectedOriginals) {
      const originalPath = selected.get(selectedPath);
      if (!originalPath || !VIDEO_EXTS.has(path.extname(originalPath).toLowerCase())) continue;
      const stem = path.basename(originalPath, path.extname(originalPath)).toLowerCase();
      for (const extension of COMPANION_EXTS) {
        const actualName = names.get(stem + extension);
        if (actualName) group.allowedPaths.add(key(path.join(group.root, actualName)));
      }
    }
  }

  return [...byDirectory.values()];
}

module.exports = { IMPORTABLE_EXTS, expandSelectedFiles, key };
