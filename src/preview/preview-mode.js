const PREVIEW_MODES=Object.freeze({BROWSE:"browse",EDIT:"edit",EXPORT:"export"});
function isDirectEditCodec(asset){
  const codec=String(asset&&asset.original&&asset.original.probe&&asset.original.probe.codec||"").toLowerCase();
  return /^(hevc|h265|h264|avc1|avc)$/.test(codec);
}
function isColorCriticalEditAsset(asset){
  return String(asset && asset.djiColorMode || '').toUpperCase() === 'D-LOG M';
}
function sourceFor(mode,asset){
  if(!asset) return null;
  if(mode===PREVIEW_MODES.BROWSE){
    if(asset.preview && asset.preview!=="UNKNOWN") return {file:asset.preview,type:"LRF_PROXY"};
    if(asset.original) return {file:asset.original,type:"ORIGINAL_FALLBACK"};
    return null;
  }
  if(mode===PREVIEW_MODES.EDIT){
    if(asset.preview && asset.preview!=="UNKNOWN") return {file:asset.preview,type:"LRF_EDIT_PREVIEW"};
    if(isColorCriticalEditAsset(asset) && asset.original) return {file:asset.original,type:"ORIGINAL_COLOR_EDIT_PREVIEW"};
    if(asset.original && isDirectEditCodec(asset)) return {file:asset.original,type:"ORIGINAL_EDIT_PREVIEW"};
    return null;
  }
  if(mode===PREVIEW_MODES.EXPORT) return asset.original ? {file:asset.original,type:"ORIGINAL"}:null;
  return null;
}
module.exports={PREVIEW_MODES,isDirectEditCodec,isColorCriticalEditAsset,sourceFor};
