import assert from 'node:assert/strict';
import { regionsForBounds, boundsOfRoutes } from './spot-catalog.js';

const regions = [
  { id: 'kyushu', count: 10, south: 30.5, north: 34.0, west: 129.0, east: 132.0, file: 'kyushu.json' },
  { id: 'kanto', count: 10, south: 34.8, north: 36.5, west: 138.5, east: 141.0, file: 'kanto.json' },
  { id: 'empty', count: 0, south: 30, north: 31, west: 130, east: 131, file: 'empty.json' }
];

const kyushuOnly = regionsForBounds(regions, { south: 33.5, north: 33.6, west: 130.2, east: 130.3 });
assert.deepEqual(kyushuOnly.map((region) => region.id), ['kyushu']);

const none = regionsForBounds(regions, { south: 26, north: 26.2, west: 127.6, east: 127.7 });
assert.equal(none.length, 0);

const all = regionsForBounds(regions, null);
assert.deepEqual(all.map((region) => region.id), ['kyushu', 'kanto']);

const bounds = boundsOfRoutes([{ shape: [[33.5, 130.2], [32.5, 131.6]] }]);
assert.ok(bounds.south <= 32.5 && bounds.north >= 33.5);
assert.ok(regionsForBounds(regions, bounds).some((region) => region.id === 'kyushu'));

console.log('spot catalog tests ok');
