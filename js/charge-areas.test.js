import assert from 'node:assert/strict';
import { buildEnergyProfile } from './route-model.js';
import {
  areasForRoutes,
  dedupeAreas,
  openAt,
  pickBestCandidate,
  socChargeAreas
} from './charge-areas.js';

function flatRoute(km, name, highway) {
  const timeSec = (km / 80) * 3600;
  const shape = [];
  for (let i = 0; i < 20; i += 1) {
    shape.push([33.5 - (km / 111) * (i / 19), 130.3 + (km / 90) * (i / 19)]);
  }
  return {
    key: highway ? 'fast' : 'local',
    requestKey: highway ? 'fast' : 'local',
    distanceKm: km,
    durationSec: timeSec,
    hasToll: highway,
    hasHighway: highway,
    hasFerry: false,
    tollKm: highway ? km : 0,
    highwayKm: highway ? km : 0,
    highwayRatio: highway ? 0.9 : 0.05,
    maneuvers: [{ lengthKm: km, timeSec, name, highway, toll: highway, instruction: '' }],
    roadSummary: name,
    shape,
    elevation: Array.from({ length: Math.round(km) + 1 }, () => 30),
    elevationIntervalM: 1000
  };
}

const leaf = {
  batteryKwh: 40,
  socPercent: 80,
  efficiencyKmPerKwh: 6.5,
  conservativeRangeKm: 220,
  maxDcKw: 50,
  safetyMarginKm: 25
};

const highway = flatRoute(294, '東九州自動車道', true);
const local = flatRoute(310, '国道10号', false);
const profiles = [highway, local].map((route) => buildEnergyProfile(route, leaf));
const areas = areasForRoutes([highway, local], profiles, leaf, '2026-10-21T07:00');
assert.ok(areas.length >= 1 && areas.length <= 6, `areas ${areas.length}`);
assert.ok(areas.every((area) => area.toKm - area.fromKm <= 40));
const raw = socChargeAreas(profiles[0], leaf);
assert.ok(raw.length >= 1 && raw.length <= 3);

const merged = dedupeAreas([
  { lat: 33.2, lon: 131.0, routeKey: 'fast', road: '東九州自動車道', highway: true },
  { lat: 33.21, lon: 131.01, routeKey: 'local', road: '国道10号', highway: false }
]);
assert.equal(merged.length, 1);
assert.ok(merged[0].routeKeys.includes('fast'));
assert.ok(merged[0].roads.includes('国道10号'));

const noon = new Date('2026-10-21T12:00:00');
assert.equal(openAt('24時間', noon), true);
assert.equal(openAt('9:00-18:00', noon), true);
assert.equal(openAt('22:00-6:00', noon), false);

const area = { lat: 33.2, lon: 131.0, highway: true, eta: noon };
const picked = pickBestCandidate([
  { name: '日産 延岡', powerKw: 44, priceType: 'per_session', operatorClass: 'emp_partner', locationType: 'general', hours: '9:00-18:00', offKm: 0.4, ai: { priceType: 'per_session' } },
  { name: '東九州道 PA', powerKw: 90, priceType: 'per_min', operatorClass: 'emp_operated', locationType: 'highway', hours: '24時間', offKm: 0.6, ai: { priceType: 'per_min' } },
  { name: '遠い超急速', powerKw: 150, priceType: 'per_min', operatorClass: 'other', locationType: 'highway', hours: '24時間', offKm: 9, ai: { priceType: 'per_min' } }
], area, leaf);
assert.equal(picked.best.name, '東九州道 PA');
assert.equal(picked.others.length, 2);

console.log('charge area tests ok', areas.length);
