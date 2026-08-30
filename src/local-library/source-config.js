"use strict";

const path = require("node:path");

function sourceKey(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  return path.resolve(value).toLowerCase();
}

function normalizePathList(values) {
  const unique = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const key = sourceKey(value);
    if (key && !unique.has(key)) unique.set(key, path.resolve(value));
  }
  return [...unique.values()];
}

function addSource(values, value) {
  return normalizePathList([...(Array.isArray(values) ? values : []), value]);
}

function removeSource(values, value) {
  const target = sourceKey(value);
  return normalizePathList(values).filter(item => sourceKey(item) !== target);
}

function isPathInside(filePath, rootPath) {
  const file = sourceKey(filePath);
  const root = sourceKey(rootPath);
  if (!file || !root) return false;
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sourceSnapshot(settings) {
  return {
    folders: normalizePathList(settings && settings.localRoots),
    files: normalizePathList(settings && settings.localFiles)
  };
}

module.exports = { sourceKey, normalizePathList, addSource, removeSource, isPathInside, sourceSnapshot };
