"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { comparablePath, assertSafeExportTarget } = require("../src/renderers/export-path-safety");

test("atomic export rejects the final source path before temporary rendering", () => {
  assert.throws(
    () => assertSafeExportTarget("C:\\camera\\DJI_0001.MP4", "C:\\camera\\DJI_0001.MP4", "win32"),
    /different from the source/
  );
});

test("Windows export targets are compared case-insensitively", () => {
  assert.equal(comparablePath("C:\\CAMERA\\DJI_0001.MP4", "win32"), comparablePath("c:\\camera\\dji_0001.mp4", "win32"));
  assert.throws(() => assertSafeExportTarget("C:\\CAMERA\\DJI_0001.MP4", "c:\\camera\\dji_0001.mp4", "win32"));
});

test("a distinct export path remains valid", () => {
  assert.doesNotThrow(() => assertSafeExportTarget("C:\\camera\\DJI_0001.MP4", "D:\\exports\\DJI_0001.mp4", "win32"));
});
