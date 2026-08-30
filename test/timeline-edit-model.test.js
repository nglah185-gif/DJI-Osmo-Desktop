const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/renderer/timeline-edit-model.js');

test('creates and splits a single segment', () => {
  const one = model.createSegments(10_000_000);
  const two = model.splitSegment(one, 'segment-1', 4_000_000, 10_000_000);
  assert.equal(two.length, 2);
  assert.deepEqual(two.map(s => [s.sourceInUs, s.sourceOutUs]), [[0, 4_000_000], [4_000_000, 10_000_000]]);
});

test('deletes selected segment without deleting the last segment', () => {
  const two = model.splitSegment(model.createSegments(10_000_000), 'segment-1', 4_000_000, 10_000_000);
  assert.equal(model.deleteSegment(two, two[0].id, 10_000_000).length, 1);
  assert.equal(model.deleteSegment([two[0]], two[0].id, 10_000_000).length, 1);
});

test('moves a segment within adjacent bounds', () => {
  const two = model.splitSegment(model.createSegments(10_000_000), 'segment-1', 4_000_000, 10_000_000);
  const moved = model.moveSegment(two, two[1].id, -2_000_000, 10_000_000);
  assert.deepEqual(moved.map(s => [s.sourceInUs, s.sourceOutUs]), [[0, 4_000_000], [4_000_000, 10_000_000]]);
});
