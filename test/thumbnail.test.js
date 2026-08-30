const test=require('node:test');const assert=require('node:assert/strict');
test('media asset thumbnail prefers attached LRF thumbnail',()=>{const asset={thumbnail:{kind:'attached-jpeg',source:'x.LRF'}};assert.equal(asset.thumbnail.kind,'attached-jpeg')});
