# TECH_STACK_V2.md

## Final choice

- Desktop shell: Electron 32+.
- Renderer: native HTML/CSS/JavaScript modules, with no React dependency in Phase 1.
- Main process: CommonJS JavaScript modules with explicit service classes and JSDoc contracts.
- IPC: Electron contextBridge with a fixed preload allowlist. Renderer receives plain serialized models only.
- Media probe: system ffprobe invoked by the main process with a fixed argument list.
- Media playback: Chromium HTMLVideoElement using a registered dji-media:// protocol. The protocol maps an opaque asset id to an authorized path.
- Tests: Node built-in test runner against the real eight-file fixture set.

## Security decisions

- contextIsolation: true.
- nodeIntegration: false.
- sandbox: true for the renderer.
- webSecurity remains enabled; no arbitrary file URL media access.
- No remote content is loaded.
- Preload exposes only scan, getPreviewUrl, and getSnapshot under window.djiMedia.
- Media URLs use an opaque id and a main-process allowlist. A renderer-supplied filesystem path is never opened.
- Device media is read-only. Scanner code only calls stat/readdir and ffprobe; it never writes to a discovered volume.
- Thumbnail cache and copying are deferred from this phase.

## Explicit exclusions

No LUT/filter/watermark pipeline, complex editing, export, proxy fallback, DUML, SWUDP, USB BULK, RNDIS control, FPV, camera control, cloud, or streaming implementation is included in Phase 1.
