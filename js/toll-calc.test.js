import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { haversineKm } from './geo.js';
import {
  nexcoOrdinaryYen,
  fukuokaUrbanYen,
  kitakyushuUrbanYen,
  tollForRoute
} from './toll-calc.js';
import { resolveToll } from './route-model.js';

assert.equal(nexcoOrdinaryYen(28.9), 950);
assert.equal(nexcoOrdinaryYen(30.8), 1000);
assert.equal(nexcoOrdinaryYen(129.8), 3480);
assert.equal(fukuokaUrbanYen('2026-10-30T10:00', true), 630);
assert.equal(fukuokaUrbanYen('2026-10-31T10:00', true), 590);
assert.equal(fukuokaUrbanYen('2026-10-30T23:00', true), 560);
assert.equal(fukuokaUrbanYen('2026-10-30T10:00', false), 630);
assert.equal(kitakyushuUrbanYen('2026-10-30T10:00', true), 520);

const table = {
  nexco: { source: 'https://www.w-nexco.co.jp/faq/01/' },
  roads: {
    maebaru: { fullYen: 370, source: 'https://www.fukuoka-dk.jp/pages/52/' },
    fukuokaUrban: { source: 'https://www.fk-tosikou.or.jp/ryokin/itiran/itiran.shtml' },
    kitakyushuUrban: { source: 'https://www.fk-tosikou.or.jp/ryokin/itiran/itiran.shtml' }
  },
  pairs: [{
    from: '太宰府',
    to: '延岡',
    yen: 4710,
    source: 'https://kosoku.jp/route.php?c=ordinary&f=dazaifu&t=nobeoka'
  }],
  junctions: [
    { name: '太宰府IC', key: '太宰府', lat: 33.53185, lon: 130.49771 },
    { name: '延岡南IC', key: '延岡', lat: 32.52521, lon: 131.66533 }
  ]
};

const start = [33.578, 130.213];
const dazaifu = [33.5313, 130.4960];
const nobeoka = [32.5298, 131.6660];
const goal = [32.550, 131.682];
const before = haversineKm(start[0], start[1], dazaifu[0], dazaifu[1]);
const nexcoKm = haversineKm(dazaifu[0], dazaifu[1], nobeoka[0], nobeoka[1]);
const after = haversineKm(nobeoka[0], nobeoka[1], goal[0], goal[1]);

const itoshima = {
  key: 'fast',
  distanceKm: before + nexcoKm + after,
  hasToll: true,
  tollKm: before * 0.7 + nexcoKm,
  shape: [start, dazaifu, nobeoka, goal],
  maneuvers: [
    { lengthKm: before * 0.25, name: '国道202号', toll: false },
    { lengthKm: before * 0.55, name: 'E35 / 西九州自動車道 / 今宿道路', toll: true, highway: true },
    { lengthKm: before * 0.2, name: '福岡都市高速2号太宰府線', toll: true, highway: true },
    { lengthKm: nexcoKm, name: 'E3 / 九州自動車道 / E34 / 大分自動車道 / E10 / 東九州自動車道', toll: true, highway: true },
    { lengthKm: after, name: '国道10号', toll: false }
  ]
};

const highway = tollForRoute(itoshima, table, { departIso: '2026-10-30T10:00', hasEtc: true });
assert.equal(highway.tollYen, 5710);
assert.equal(highway.provisional, false);
assert.equal(highway.from, 'table');
const resolved = resolveToll(itoshima, highway);
assert.equal(resolved.tollYen, 5710);
assert.equal(resolved.provisional, false);

const formulaOnly = tollForRoute({
  key: 'short',
  distanceKm: 40,
  hasToll: true,
  shape: [[33.2, 130.5], [33.5, 130.8]],
  maneuvers: [{ lengthKm: 40, name: 'E3 / 九州自動車道', toll: true, highway: true }]
}, table, { departIso: '2026-10-30T10:00', hasEtc: true });
assert.equal(formulaOnly.provisional, true);
assert.equal(formulaOnly.tollYen, nexcoOrdinaryYen(40));
assert.notEqual(formulaOnly.tollYen, 370);

const noToll = tollForRoute({
  key: 'local',
  distanceKm: 20,
  hasToll: false,
  maneuvers: [{ lengthKm: 20, name: '国道10号', toll: false }]
}, table, {});
assert.equal(noToll.tollYen, 0);
assert.equal(noToll.tollKnown, true);

const unknown = tollForRoute({
  key: 'odd',
  distanceKm: 12,
  hasToll: true,
  maneuvers: [{ lengthKm: 12, name: '県道の有料道路', toll: true }]
}, table, {});
assert.equal(unknown.tollKnown, false);
assert.equal(unknown.tollYen, null);

const bundled = JSON.parse(readFileSync(new URL('../data/tolls-kyushu.json', import.meta.url), 'utf8'));
const live = tollForRoute(itoshima, bundled, { departIso: '2026-10-30T10:00', hasEtc: true });
assert.equal(live.tollYen, 5710);
assert.equal(live.provisional, false);
