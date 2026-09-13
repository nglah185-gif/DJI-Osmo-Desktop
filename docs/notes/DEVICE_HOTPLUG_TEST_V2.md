# DEVICE_HOTPLUG_TEST_V2.md

## Purpose

This regression covers the Action 4 Windows Mass Storage path across physical removal and reinsertion. It validates state transitions rather than only the first scan.

## Required physical sequence

1. Start the application with Action 4 unplugged: ABSENT / No DJI camera detected.
2. Connect Action 4 as Windows Mass Storage.
3. Observe POSSIBLE_DJI_STORAGE, DJI Osmo Action 4 / HG302, F:\\, SD_Card, exFAT and PnP VID_2CA3&PID_0020 evidence.
4. Observe automatic DCIM scan and MP4/LRF/AAC counts.
5. Unplug the camera and observe automatic return to ABSENT.
6. Insert it again and observe the second successful Action 4 detection and scan.
7. Unplug it at the end.

## Semi-automated runner

Run from the V2 directory. In PowerShell:

    Set-Location -LiteralPath 'E:\\dji_desktop(1)\\dji-osmo-desktop-v2'
    $env:HOTPLUG_INTERVAL_MS = '3000'
    $env:HOTPLUG_TIMEOUT_MS = '900000'
    node .\scripts\device-hotplug-regression.js

In cmd.exe:

    cd /d "E:\\dji_desktop(1)\\dji-osmo-desktop-v2"
    set HOTPLUG_INTERVAL_MS=3000
    set HOTPLUG_TIMEOUT_MS=900000
    node scripts\device-hotplug-regression.js

The runner uses the production WindowsMassStorageDeviceProvider; it does not inject fake volumes. It prints each observed transition and returns exit code 0 only after ABSENT -> PRESENT -> ABSENT -> PRESENT -> ABSENT. The application itself polls every 3 seconds and pushes the new snapshot to the renderer.

## Automated state-machine coverage

The hotplug regression test verifies the transition evaluator, Action 4 evidence rendering, rejection of incomplete cycles and no-device timeout behavior. These tests use snapshots only to test the state machine; they do not claim physical hardware was present.

## Current hardware run

Completed on 2026-08-27 with the production provider. The runner was started while the camera was already connected, then observed:

    PRESENT -> ABSENT -> PRESENT -> ABSENT -> PRESENT -> ABSENT

This is two complete unplug/reinsert cycles ending disconnected. The detected device was F:\\ / SD_Card / exFAT with DJI Osmo Action 4 / HG302, VID_2CA3&PID_0020, DCIM, MP4, LRF and AAC evidence. The evaluator accepts an already-connected initial baseline and still requires both complete cycles.
