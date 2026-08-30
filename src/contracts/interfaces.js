class CameraDeviceProvider { async discover() { throw new Error("CameraDeviceProvider.discover is not implemented"); } }
class MediaAccess { async listMediaFiles() { throw new Error("MediaAccess.listMediaFiles is not implemented"); } async stat() { throw new Error("MediaAccess.stat is not implemented"); } }
class MediaProbe { async probe() { throw new Error("MediaProbe.probe is not implemented"); } }
class PairingEngine { pair() { throw new Error("PairingEngine.pair is not implemented"); } }
class MediaCatalog { replace() { throw new Error("MediaCatalog.replace is not implemented"); } getSnapshot() { throw new Error("MediaCatalog.getSnapshot is not implemented"); } }
class PreviewSource { resolve() { throw new Error("PreviewSource.resolve is not implemented"); } }
module.exports = { CameraDeviceProvider, MediaAccess, MediaProbe, PairingEngine, MediaCatalog, PreviewSource };
