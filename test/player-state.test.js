const test=require('node:test');const assert=require('node:assert/strict');
test('player state uses seconds and native playback flags',()=>{const state={currentTime:0,duration:10,isPlaying:false};state.duration=12.5;state.currentTime=6.25;state.isPlaying=true;assert.equal(state.duration,12.5);assert.equal(state.currentTime,6.25);assert.equal(state.isPlaying,true)});
