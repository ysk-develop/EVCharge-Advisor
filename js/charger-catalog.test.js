import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { indexCatalog, chargersAlongRoutes } from './charger-catalog.js';
import { dedupeChargers, recordFromTags } from '../scripts/build-chargers.mjs';

const data = JSON.parse(readFileSync(new URL('../data/chargers-jp.json', import.meta.url), 'utf8'));
assert.equal(data.counts.total, data.chargers.length);
assert.ok(data.counts.total > 500);
assert.ok(data.counts.kyushu >= 40);
assert.equal(data.attribution.find((item) => item.name === 'Open Charge Map').included, false);

const catalog = indexCatalog(data);
const along = chargersAlongRoutes(catalog, [{
  shape: [[33.578, 130.213], [33.25, 130.97], [32.55, 131.68]]
}], 12);
assert.ok(along.length >= 1, `expected chargers on the Kyushu corridor, got ${along.length}`);

const dupes = dedupeChargers([
  recordFromTags({ tags: { name: '糸島PA', 'socket:chademo': '1', 'socket:chademo:output': '50' }, lat: 33.5, lon: 130.5, source: 'osm', sourceId: 'n1', updated: 1700000000 }),
  recordFromTags({ tags: { name: '糸島PA', operator: 'e-Mobility Power' }, lat: 33.5002, lon: 130.5002, source: 'ocm', sourceId: 'ocm/2', updated: '2026-01-01' })
]);
assert.equal(dupes.length, 1);
assert.equal(dupes[0].maxKw, 50);
assert.ok(dupes[0].connectors.includes('CHAdeMO'));

console.log('charger catalog tests ok', data.counts);
