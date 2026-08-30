const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const fs = require("node:fs/promises");
const { MEDIA_EXTENSIONS } = require("../media-access/read-only-media-access");
const execFileAsync = promisify(execFile);

class WindowsMassStorageDeviceProvider {
  constructor(options = {}) {
    this.execFile = options.execFile || execFileAsync;
    this.fs = options.fs || fs;
    this.platform = options.platform || process.platform;
  }

  async discover() {
    if (this.platform !== "win32") return [];
    const [volumes, pnpDevices] = await Promise.all([this.listVolumes(), this.listPnpDevices()]);
    const identity = identifyDjiDevice(pnpDevices);
    const devices = [];
    for (const volume of volumes) {
      const dcimPath = path.join(volume.path, "DCIM");
      const djiPath = path.join(volume.path, "DJI");
      const [dcim, dji] = await Promise.all([this.exists(dcimPath), this.exists(djiPath)]);
      if (!dcim && !dji) continue;
      const files = dcim ? await this.listMedia(dcimPath) : [];
      const kinds = new Set(files.map(file => path.extname(file).toLowerCase()));
      const mediaEvidence = { mp4: kinds.has(".mp4"), lrf: kinds.has(".lrf"), aac: kinds.has(".aac") };
      const removable = String(volume.driveType || "").toLowerCase() === "removable";
      const volumeIdentity = removable ? identity : identifyDjiDevice([]);
      const evidence = {
        windowsVolume: true,
        fileSystem: volume.fileSystem || "UNKNOWN",
        volumeLabel: volume.label || "UNKNOWN",
        driveType: volume.driveType || "UNKNOWN",
        dcim,
        djiDirectory: dji,
        ...mediaEvidence,
        pnpCameraName: volumeIdentity.cameraName,
        pnpFriendlyNames: volumeIdentity.friendlyNames,
        pnpInstanceIds: volumeIdentity.instanceIds,
        djiUsbVidPid: volumeIdentity.hasDjiUsb ? "VID_2CA3&PID_0020" : "UNKNOWN",
        cameraIdentitySource: volumeIdentity.source
      };
      const storageScore = (volume.fileSystem === "exFAT" ? 20 : volume.fileSystem ? 10 : 0) + (dcim ? 40 : 0) + (dji ? 10 : 0) + (files.length ? 30 : 0);
      const identityScore = volumeIdentity.hasDjiUsb ? 25 : volumeIdentity.cameraName !== "UNKNOWN" ? 20 : 0;
      const score = Math.min(100, storageScore + identityScore);
      const cameraModel = volumeIdentity.cameraName !== "UNKNOWN" ? volumeIdentity.cameraName : volumeIdentity.hasDjiUsb && dcim && files.length ? "DJI Osmo Action 4 / HG302" : "UNKNOWN";
      devices.push({ id: "volume:" + volume.path.toUpperCase(), kind: "Windows Mass Storage", path: volume.path, label: volume.label || "Removable volume", fileSystem: volume.fileSystem || "UNKNOWN", cameraModel, score, evidence, status: score >= 60 ? "POSSIBLE_DJI_STORAGE" : "UNVERIFIED_STORAGE" });
    }
    return devices.sort((a, b) => b.score - a.score);
  }

  async listVolumes() {
    const command = "$ErrorActionPreference='Stop'; Get-Volume | Where-Object { $_.DriveLetter } | Select-Object DriveLetter,FileSystem,FileSystemLabel,DriveType | ConvertTo-Json -Compress";
    try {
      const { stdout } = await this.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 10000 });
      const value = JSON.parse(stdout.trim() || "[]");
      const rows = Array.isArray(value) ? value : [value];
      return rows.filter(row => row.DriveLetter).map(row => ({ path: String(row.DriveLetter).replace(/:$/, "") + ":\\", fileSystem: row.FileSystem || "UNKNOWN", label: row.FileSystemLabel || "", driveType: row.DriveType || "UNKNOWN" }));
    } catch { return []; }
  }

  async listPnpDevices() {
    const command = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_PnPEntity | Select-Object Name,PNPClass,PNPDeviceID,Status | ConvertTo-Json -Compress";
    try {
      const { stdout } = await this.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 10000 });
      const value = JSON.parse(stdout.trim() || "[]");
      return (Array.isArray(value) ? value : [value]).filter(row => row && (row.Name || row.PNPDeviceID));
    } catch { return []; }
  }

  async exists(targetPath) { try { await this.fs.access(targetPath); return true; } catch { return false; } }

  async listMedia(rootPath) {
    const result = [];
    const walk = async current => {
      let entries;
      try { entries = await this.fs.readdir(current, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(target);
        else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) result.push(target);
      }
    };
    await walk(rootPath);
    return result;
  }
}

function identifyDjiDevice(devices) {
  const rows = devices.map(device => ({ name: String(device.Name || ""), id: String(device.PNPDeviceID || ""), status: String(device.Status || "") }));
  const djiRows = rows.filter(row => /VID_2CA3&PID_0020/i.test(row.id) || /DJI|Osmo|Action/i.test(row.name));
  const friendlyNames = [...new Set(djiRows.map(row => row.name).filter(Boolean))];
  const actualName = friendlyNames.find(name => /Osmo|Action|DJI/i.test(name) && !/^BULK Interface$/i.test(name));
  const hasDjiUsb = djiRows.some(row => /VID_2CA3&PID_0020/i.test(row.id));
  return { hasDjiUsb, cameraName: normalizeDjiCameraName(actualName), friendlyNames, instanceIds: djiRows.map(row => row.id), source: actualName ? "Windows PnP friendly name" : hasDjiUsb ? "Windows PnP VID_2CA3&PID_0020" : "UNKNOWN" };
}
function normalizeDjiCameraName(name) {
  const value = String(name || "");
  if (/^OsmoAction4$/i.test(value)) return value;
  if (/Action\s*6|OsmoAction6/i.test(value)) return "DJI Osmo Action 6";
  if (/Action\s*5|OsmoAction5/i.test(value)) return "DJI Osmo Action 5 Pro";
  if (/Action\s*4|OsmoAction4|HG302/i.test(value)) return "DJI Osmo Action 4 / HG302";
  if (/Action\s*3|OsmoAction3/i.test(value)) return "DJI Osmo Action 3";
  if (/Pocket\s*4\s*Pro|OsmoPocket4Pro/i.test(value)) return "DJI Osmo Pocket 4 Pro";
  if (/Pocket\s*4|OsmoPocket4/i.test(value)) return "DJI Osmo Pocket 4";
  if (/Pocket\s*3|OsmoPocket3/i.test(value)) return "DJI Osmo Pocket 3";
  if (/Osmo\s*Nano|OsmoNano/i.test(value)) return "DJI Osmo Nano";
  return name || "UNKNOWN";
}

module.exports = { WindowsMassStorageDeviceProvider, identifyDjiDevice, normalizeDjiCameraName };
