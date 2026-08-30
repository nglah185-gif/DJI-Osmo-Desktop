# DJI Osmo Desktop V2

`v3.0_beta` preview source release.

DJI Osmo Desktop V2 is a Windows Electron application for browsing DJI camera
media, identifying supported camera models, previewing D-Log/D-Log M color
restoration, applying model-specific watermarks, performing basic single-track
non-destructive edits, and exporting H.264 MP4 files.

## Preview Status

This repository is a preview build and is not ready for production use. Known
areas requiring real-device validation include long-running 59.94 fps playback,
audio/video synchronization, speed changes, rotated preview geometry, watermark
placement, and packaged startup on clean Windows systems.

## Development

Requirements:

- Windows
- Node.js
- FFmpeg and FFprobe available to the application

Install and run:

```powershell
npm install
npm start
```

Run tests:

```powershell
npm test
```

Build the portable package:

```powershell
npm run package:portable
```

## External Resources

Official camera LUT and watermark assets are not included in this source
repository. The application currently resolves these resources from sibling
workspace directories such as `cube&luts`, `lut&log`, and `watermark`.
Only use and redistribute those assets under their applicable licenses.

## Scope

The preview focuses on a single video track, non-destructive trimming and
cutting, timeline interaction, color restoration, geometric transforms,
watermarks, device detection, and export. It does not provide multi-track
editing, a separate audio track, advanced transitions, keyframes, or AI tools.
