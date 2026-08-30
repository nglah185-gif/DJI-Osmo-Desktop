class InMemoryMediaCatalog {
  constructor() { this.snapshot = { devices: [], assets: [], files: [], status: "NOT_SCANNED", scannedAt: null, errors: [] }; }
  replace(snapshot) { this.snapshot = snapshot; }
  getSnapshot() { return this.snapshot; }
  getAsset(assetId) { return this.snapshot.assets.find(asset => asset.id === assetId) || null; }
}

function findAssetInCatalogs(assetId, ...catalogs) {
  for (const catalog of catalogs) {
    const asset = catalog && catalog.getAsset(assetId);
    if (asset) return asset;
  }
  return null;
}

module.exports = { InMemoryMediaCatalog, findAssetInCatalogs };
