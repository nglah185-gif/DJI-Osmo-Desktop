"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createEffectGraph } = require("../src/color/effect-graph");
const { FfmpegExportRenderer, buildExportArgs } = require("../src/renderers/ffmpeg-export-renderer");
const {
  softwareEncoderArgs, softwareThreadCap, hardwareEncoderArgs, encoderArgs,
  hardwareCandidates, isHardwareEncoderFailure, probeHardwareEncoder, EncoderSelector,
  hardwareDecodeArgs
} = require("../src/renderers/encoder-selection");

// render() creates the destination directory, so the output has to live
// somewhere writable. A drive root fails with EPERM on Windows.
function tempOutput() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dji-encoder-"));
  return path.join(dir, "out.mp4");
}

function fakeChild({ code = 0, stderr = "", stdout = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child;
}

// render() probes the source with ffprobe before choosing an encoder. These
// tests are about encoder selection, so the probe is answered with a layout that
// cannot be stream copied -- otherwise the export takes the passthrough path and
// never reaches the encoder at all.
function isProbe(args) {
  return Array.isArray(args) && args.includes("-show_entries");
}

function fakeProbeChild() {
  return fakeChild({ code: 0, stdout: JSON.stringify({ streams: [], format: {} }) });
}

test("software encoder keeps the established CRF 18 quality target", () => {
  const args = softwareEncoderArgs();
  assert.deepEqual(args, ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]);
});

test("software thread cap applies only at 4K where x264 memory actually blew up", () => {
  // Measured: 12 threads peaked at 3266 MB on 4K, 4 threads at 2195 MB. The cap
  // costs speed, so 1080p exports must stay uncapped.
  assert.equal(softwareThreadCap(1920, 1080), 0);
  assert.equal(softwareThreadCap(3840, 2160), 8);
  assert.equal(softwareThreadCap(undefined, undefined), 0);
  assert.equal(softwareThreadCap(0, 0), 0);
  assert.ok(softwareEncoderArgs({ width: 3840, height: 2160 }).includes("-threads"));
  assert.ok(!softwareEncoderArgs({ width: 1920, height: 1080 }).includes("-threads"));
});

test("hardware encoders map quality onto their own scale instead of reusing CRF", () => {
  const nvenc = hardwareEncoderArgs("h264_nvenc");
  assert.deepEqual(nvenc, ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "21", "-pix_fmt", "yuv420p"]);
  assert.ok(!nvenc.includes("-crf"));
  for (const encoder of ["h264_qsv", "h264_amf", "h264_videotoolbox"]) {
    const args = hardwareEncoderArgs(encoder);
    assert.equal(args[1], encoder);
    assert.ok(!args.includes("-crf"), encoder + " must not use the x264 CRF scale");
  }
  assert.throws(() => hardwareEncoderArgs("h264_madeup"), /Unknown hardware encoder/);
});

test("encoderArgs falls back to software for null and for libx264 by name", () => {
  assert.deepEqual(encoderArgs(null), softwareEncoderArgs());
  assert.deepEqual(encoderArgs("libx264"), softwareEncoderArgs());
  assert.equal(encoderArgs("h264_nvenc")[1], "h264_nvenc");
});

test("every hardware candidate produces H.264 so output stays interchangeable", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const list = hardwareCandidates(platform);
    assert.ok(list.length > 0, platform + " needs at least one candidate");
    for (const encoder of list) assert.match(encoder, /^h264_/);
  }
  assert.deepEqual(hardwareCandidates("freebsd"), []);
});

test("probe runs a real tiny encode rather than trusting the -encoders list", async () => {
  const calls = [];
  const encoder = await probeHardwareEncoder({
    ffmpegPath: "ffmpeg", platform: "win32",
    runFfmpeg: async (command, args) => { calls.push(args); return { code: 0 }; }
  });
  assert.equal(encoder, "h264_nvenc");
  assert.equal(calls.length, 1);
  // Listing encoders would pass on machines with no NVIDIA GPU at all, so the
  // probe has to actually encode frames and write them somewhere discardable.
  assert.ok(!calls[0].includes("-encoders"));
  assert.ok(calls[0].includes("-f") && calls[0].includes("lavfi"));
  assert.ok(calls[0].includes("h264_nvenc"));
  assert.equal(calls[0][calls[0].length - 1], "-");
});

test("probe walks candidates in order and returns null when none work", async () => {
  const tried = [];
  const first = await probeHardwareEncoder({
    platform: "win32",
    runFfmpeg: async (command, args) => {
      const name = args[args.indexOf("-c:v") + 1];
      tried.push(name);
      return { code: name === "h264_qsv" ? 0 : 1 };
    }
  });
  assert.equal(first, "h264_qsv");
  assert.deepEqual(tried, ["h264_nvenc", "h264_qsv"]);

  // h264_mf is the last resort: it must only be reached once every vendor
  // encoder has failed, since it gives less quality control than they do.
  const vendorsDown = [];
  const fallback = await probeHardwareEncoder({
    platform: "win32",
    runFfmpeg: async (command, args) => {
      const name = args[args.indexOf("-c:v") + 1];
      vendorsDown.push(name);
      return { code: name === "h264_mf" ? 0 : 1 };
    }
  });
  assert.equal(fallback, "h264_mf");
  assert.deepEqual(vendorsDown, ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf"]);

  const none = await probeHardwareEncoder({ platform: "win32", runFfmpeg: async () => ({ code: 1 }) });
  assert.equal(none, null);
});

test("probe survives a runFfmpeg that throws and keeps checking later candidates", async () => {
  const encoder = await probeHardwareEncoder({
    platform: "win32",
    runFfmpeg: async (command, args) => {
      if (args.includes("h264_nvenc")) throw new Error("spawn ENOENT");
      return { code: 0 };
    }
  });
  assert.equal(encoder, "h264_qsv");
});

test("encoder failures are distinguished from ordinary ffmpeg failures", () => {
  assert.ok(isHardwareEncoderFailure("Cannot load nvcuda.dll"));
  assert.ok(isHardwareEncoderFailure("No capable devices found"));
  assert.ok(isHardwareEncoderFailure("OpenEncodeSessionEx failed: out of memory (10)"));
  assert.ok(isHardwareEncoderFailure("Unknown encoder 'h264_nvenc'"));
  // A bad filter graph or unwritable destination must NOT trigger a silent
  // software retry: the user needs the real error, not a slower repeat failure.
  assert.ok(!isHardwareEncoderFailure("Invalid argument"));
  assert.ok(!isHardwareEncoderFailure("No such file or directory"));
  assert.ok(!isHardwareEncoderFailure("Permission denied"));
  assert.ok(!isHardwareEncoderFailure(""));
  assert.ok(!isHardwareEncoderFailure(null));
});

test("selector probes once per session and caches a negative result too", async () => {
  let probes = 0;
  const selector = new EncoderSelector({ platform: "win32", runFfmpeg: async () => { probes++; return { code: 1 }; } });
  assert.equal(await selector.select(), null);
  assert.equal(await selector.select(), null);
  // Every candidate tried once each, not once per select() call.
  assert.equal(probes, hardwareCandidates("win32").length);
});

test("concurrent select calls share a single probe", async () => {
  let probes = 0;
  const selector = new EncoderSelector({
    platform: "win32",
    runFfmpeg: async () => { probes++; await new Promise(resolve => setImmediate(resolve)); return { code: 0 }; }
  });
  const [a, b] = await Promise.all([selector.select(), selector.select()]);
  assert.equal(a, "h264_nvenc");
  assert.equal(b, "h264_nvenc");
  assert.equal(probes, 1);
});

test("selector honors preferHardware false and stays disabled after a runtime failure", async () => {
  const off = new EncoderSelector({ platform: "win32", preferHardware: false, runFfmpeg: async () => { throw new Error("must not probe"); } });
  assert.equal(await off.select(), null);

  const selector = new EncoderSelector({ platform: "win32", runFfmpeg: async () => ({ code: 0 }) });
  assert.equal(await selector.select(), "h264_nvenc");
  selector.disableHardware();
  assert.equal(await selector.select(), null);
});

test("export args place the encoder after the filter graph and keep audio handling intact", () => {
  const args = buildExportArgs({
    encoder: "h264_nvenc", inputPath: "C:/in.mp4", outputPath: "C:/out.mp4",
    filterGraph: "[0:v]null[outv]", sourceIn: 1, sourceDuration: 4, speed: 2, muted: false, volume: 0.5
  });
  assert.ok(args.indexOf("-c:v") > args.indexOf("-filter_complex"));
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_nvenc");
  assert.equal(args[args.length - 1], "C:/out.mp4");
  assert.equal(args[args.indexOf("-t") + 1], "2");
  assert.match(args[args.indexOf("-af") + 1], /atempo=2\.000000,volume=0\.5000/);

  const mutedArgs = buildExportArgs({ encoder: null, inputPath: "a", outputPath: "b", filterGraph: "g", speed: 1, muted: true });
  assert.ok(mutedArgs.includes("-an"));
  assert.ok(!mutedArgs.includes("-af"));
  assert.equal(mutedArgs[mutedArgs.indexOf("-c:v") + 1], "libx264");
});

test("dxva2 decode is applied on Windows hardware exports and nowhere else", () => {
  const args = buildExportArgs({
    encoder: "h264_nvenc", inputPath: "C:/in.mp4", outputPath: "C:/out.mp4",
    filterGraph: "[0:v]null[outv]", speed: 1, muted: true, platform: "win32"
  });
  // -hwaccel is an input option, so it is only honored before the -i it applies
  // to. After -i, ffmpeg ignores it and the measured gain silently disappears.
  assert.ok(args.indexOf("-hwaccel") < args.indexOf("-i"));
  assert.equal(args[args.indexOf("-hwaccel") + 1], "dxva2");

  // cuda regressed on this footage; only the measured winner is allowed, which
  // is why this is an allow-list and not -hwaccel auto.
  assert.ok(!args.includes("cuda"));

  const software = buildExportArgs({
    encoder: null, inputPath: "a", outputPath: "b", filterGraph: "g",
    speed: 1, muted: true, platform: "win32"
  });
  assert.ok(!software.includes("-hwaccel"), "software retry must stay unchanged");

  for (const platform of ["darwin", "linux"]) {
    const other = buildExportArgs({
      encoder: "h264_videotoolbox", inputPath: "a", outputPath: "b", filterGraph: "g",
      speed: 1, muted: true, platform
    });
    assert.ok(!other.includes("-hwaccel"), platform + " decode was never measured");
  }
});

test("hardwareDecodeArgs defaults to the running platform and ignores unknown ones", () => {
  assert.deepEqual(hardwareDecodeArgs({ encoder: "h264_nvenc", platform: "freebsd" }), []);
  assert.deepEqual(hardwareDecodeArgs({ encoder: null, platform: "win32" }), []);
  assert.deepEqual(hardwareDecodeArgs({ encoder: "libx264", platform: "win32" }), []);
  assert.deepEqual(hardwareDecodeArgs({}), []);
});

test("export retries in software when the hardware encoder fails at runtime", async () => {
  const spawned = [];
  const renderer = new FfmpegExportRenderer({
    encoderSelector: { select: async () => "h264_nvenc", disableHardware() { this.disabled = true; } },
    spawnProcess: (command, args) => {
      if (isProbe(args)) return fakeProbeChild();
      spawned.push(args);
      const usesNvenc = args.includes("h264_nvenc");
      return fakeChild(usesNvenc ? { code: 1, stderr: "OpenEncodeSessionEx failed: out of memory (10)" } : { code: 0 });
    }
  });
  const result = await renderer.render({ inputPath: "C:/in.mp4", outputPath: tempOutput(), graph: createEffectGraph(), lutRegistry: {} });
  assert.equal(spawned.length, 2);
  assert.ok(spawned[0].includes("h264_nvenc"));
  assert.ok(spawned[1].includes("libx264"));
  assert.equal(result.hardwareEncoder, false);
  assert.equal(result.encoder, "libx264");
  assert.equal(renderer.encoderSelector.disabled, true);
});

test("export does not retry when the failure is not the encoder's fault", async () => {
  const spawned = [];
  const renderer = new FfmpegExportRenderer({
    encoderSelector: { select: async () => "h264_nvenc", disableHardware() { this.disabled = true; } },
    spawnProcess: (command, args) => {
      if (isProbe(args)) return fakeProbeChild();
      spawned.push(args);
      return fakeChild({ code: 1, stderr: "Invalid argument" });
    }
  });
  await assert.rejects(
    () => renderer.render({ inputPath: "C:/in.mp4", outputPath: tempOutput(), graph: createEffectGraph(), lutRegistry: {} }),
    /Invalid argument/
  );
  assert.equal(spawned.length, 1);
  assert.notEqual(renderer.encoderSelector.disabled, true);
});

test("a canceled hardware export is not retried in software", async () => {
  const spawned = [];
  const controller = new AbortController();
  const renderer = new FfmpegExportRenderer({
    encoderSelector: { select: async () => "h264_nvenc", disableHardware() { this.disabled = true; } },
    spawnProcess: (command, args) => {
      if (isProbe(args)) return fakeProbeChild();
      spawned.push(args);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => { child.emit("close", 137); return true; };
      setImmediate(() => controller.abort());
      return child;
    }
  });
  await assert.rejects(
    () => renderer.render({ inputPath: "C:/in.mp4", outputPath: tempOutput(), graph: createEffectGraph(), lutRegistry: {}, signal: controller.signal }),
    /canceled/
  );
  assert.equal(spawned.length, 1);
});

test("hardware export reports the encoder it actually used", async () => {
  const renderer = new FfmpegExportRenderer({
    encoderSelector: { select: async () => "h264_nvenc", disableHardware() {} },
    spawnProcess: () => fakeChild({ code: 0 })
  });
  const result = await renderer.render({ inputPath: "C:/in.mp4", outputPath: tempOutput(), graph: createEffectGraph(), lutRegistry: {} });
  assert.equal(result.encoder, "h264_nvenc");
  assert.equal(result.hardwareEncoder, true);
});
