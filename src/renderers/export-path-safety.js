"use strict";

const fs = require("node:fs");
const path = require("node:path");

function comparablePath(value, platform = process.platform) {
  let resolved = path.resolve(String(value || ""));
  try { resolved = fs.realpathSync.native(resolved); } catch { /* destination may not exist yet */ }
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertSafeExportTarget(inputPath, outputPath, platform = process.platform) {
  if (!inputPath || !outputPath) throw new Error("Export input and output paths are required");
  if (comparablePath(inputPath, platform) === comparablePath(outputPath, platform)) {
    throw new Error("Export output must be different from the source file");
  }
}

module.exports = { comparablePath, assertSafeExportTarget };
