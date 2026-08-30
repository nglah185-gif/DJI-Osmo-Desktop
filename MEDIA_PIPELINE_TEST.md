# MEDIA_PIPELINE_TEST.md

## Scope

Phase 1 validates the path from a read-only filesystem to a MediaAsset and LRF preview source. The fixture is the eight-file set in the workspace dji-test-media directory.

## Required coverage

| Check | Test | Expected |
|---|---|---|
| 4 MP4 | offline pipeline | 4 files and 4 MediaAsset originals |
| 2 LRF | offline pipeline | 2 preview files |
| 2 AAC | offline pipeline | 2 ExternalAudioCandidate values |
| MP4/LRF pairing | pairing evidence test | 2 HIGH_CONFIDENCE, 0 CONFIRMED claims |
| AAC candidate | pairing evidence test | association candidates with syncStatus UNKNOWN |
| ffprobe | normalization test | codec, profile, geometry, audio, metadata and timecode are populated; absent audio is UNKNOWN |
| LRF preview source | preview resolver test | paired asset returns READY and an LRF path |
| LRF seek | ffmpeg test | both LRF samples decode at 500 ms |
| portrait geometry | geometry test | Original -90 rotation is preserved; Preview remains independently UNKNOWN |
| UI non-blocking | bounded scan test | scan completes within 60 seconds and fixture signatures are unchanged |
| device false positive guard | provider test | non-Windows provider returns no devices |

## Commands

Run in PowerShell:

    Set-Location -LiteralPath 'E:\dji_desktop(1)\dji-osmo-desktop-v2'
    npm install
    npm test
    npm start

The path must be quoted or passed through -LiteralPath because its parent directory contains parentheses.

The test suite uses the actual MP4/LRF/AAC fixture files and the installed ffprobe/ffmpeg commands. It does not use media mocks. The Electron UI scans the same fixture directory for offline verification and separately enumerates Windows volumes.

## Acceptance result

Acceptance completed on the current workspace. Offline test command passed 8/8 tests: 4 MP4, 2 LRF, 2 AAC, 2 HIGH_CONFIDENCE MP4/LRF pairings, 2 AAC candidates with UNKNOWN sync, ffprobe normalization, 500 ms LRF seek, portrait geometry, read-only signatures, and bounded scan.

Connected-device verification also completed against F:\ (volume label SD_Card, exFAT): 85 MP4, 78 LRF, 7 AAC, 85 MediaAsset originals, 72 HIGH_CONFIDENCE pairings, 7 AAC candidates, and 0 probe errors. The UI status is POSSIBLE_DJI_STORAGE for the real volume and displays the Action 4 identity from Windows PnP/VID-PID evidence. The application checks the device signature every 3 seconds and automatically rescans after a camera volume is inserted or removed. No writes were performed. A secondary E:\ volume was retained as UNVERIFIED_STORAGE because it has a DJI-named directory but no DCIM media evidence. When no camera is attached, the UI shows No DJI camera detected and never invents a camera identity.

## Out of scope

Proxy fallback, LUTs, filters, watermarks, editing, export, DUML, SWUDP, USB BULK, RNDIS control, FPV, camera control and cloud features are intentionally not tested or implemented in this phase.
