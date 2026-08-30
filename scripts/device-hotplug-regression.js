const { WindowsMassStorageDeviceProvider } = require("../src/device-adapter/windows-mass-storage-device-provider");
const { HotplugRegressionHarness } = require("../src/device-adapter/hotplug-regression");
const intervalMs = Number(process.env.HOTPLUG_INTERVAL_MS || 3000);
const timeoutMs = Number(process.env.HOTPLUG_TIMEOUT_MS || 900000);
const provider = new WindowsMassStorageDeviceProvider();
const harness = new HotplugRegressionHarness({ provider, intervalMs });
console.log("HOTPLUG TEST: physically cycle the Action 4 twice.");
console.log("Required sequence: absent -> present -> absent -> present -> absent.");
harness.runReal({ cycles: 2, timeoutMs, onEvent: event => console.log(JSON.stringify(event)) }).then(result => { console.log(JSON.stringify(result, null, 2)); process.exitCode = result.pass ? 0 : 1; }).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
