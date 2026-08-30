const path = require("node:path");
const { decodeRgbImage } = require("../src/color/hald-lut");
(async () => {
  const image = await decodeRgbImage(path.join(__dirname, "..", "..", "dji.mimo", "assets", "DJI-Assets", "filter", "FT_StyleA06", "neutral_lut_A06.jpg"));
  const pixel = (x, y) => { const i = (y * image.width + x) * 3; return [...image.data.slice(i, i + 3)].map(value => Math.round(value / 255 * 1000) / 1000); };
  console.log(JSON.stringify({ width: image.width, height: image.height, samples: [[0,0],[63,0],[64,0],[127,0],[128,0],[0,63],[0,64],[1023,511],[1024,512]].map(([x,y]) => ({x,y,value:pixel(x,y)})) }, null, 2));
})();
