import assert from 'node:assert/strict';
import { decodePolyline } from './geo.js';
import {
  PARTNER_CAUTION,
  resolveChargerPrice,
  effectiveYenPerMin,
  estimateSessionCost,
  formatUnitPrice,
  classifyOperator
} from './charger-price.js';
import { getDefaultPriceMaster } from './price-master.js';
import {
  buildEnergyProfile,
  planStops,
  prepareRouteItem,
  assembleComparison,
  resolveToll,
  estimateChargeMinutes,
  speedFactor,
  routeViaLine,
  googleDirectionsUrl,
  appleDirectionsUrl
} from './route-model.js';
import { normalizeResearchedCharger, normalizeToll, matchToll } from './route-research.js';

function flatRoute(km, kmh, { highway = false, elevation } = {}) {
  const timeSec = (km / kmh) * 3600;
  const n = Math.max(2, Math.round(km) + 1);
  const elev = elevation || Array.from({ length: n }, () => 20);
  const shape = [];
  for (let i = 0; i < 16; i += 1) {
    shape.push([35 + (km / 111) * (i / 15), 139.1]);
  }
  return {
    key: highway ? 'fast' : 'local',
    requestKey: highway ? 'fast' : 'local',
    distanceKm: km,
    durationSec: timeSec,
    hasToll: highway,
    hasHighway: highway,
    hasFerry: false,
    tollKm: highway ? km * 0.8 : 0,
    highwayKm: highway ? km : 0,
    highwayRatio: highway ? 0.9 : 0,
    maneuvers: [{
      lengthKm: km,
      timeSec,
      name: highway ? '東名高速道路' : '国道1号',
      highway,
      toll: highway,
      instruction: ''
    }],
    roadSummary: highway ? '東名高速道路' : '国道1号',
    shape,
    elevation: elev,
    elevationIntervalM: 1000
  };
}

const leaf = {
  socPercent: 80,
  batteryKwh: 40,
  efficiencyKmPerKwh: 8,
  conservativeRangeKm: 200,
  maxDcKw: 50,
  safetyMarginKm: 25
};

const decoded = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
assert.equal(decoded.length, 3);
assert.ok(Math.abs(decoded[0][0] - 38.5) < 0.01);
assert.ok(Math.abs(decoded[2][0] - 43.252) < 0.01);

assert.ok(speedFactor(100) > speedFactor(60));

const flat = buildEnergyProfile(flatRoute(100, 60), leaf);
const fast = buildEnergyProfile(flatRoute(100, 100, { highway: true }), leaf);
assert.ok(fast.totalKwh > flat.totalKwh, `highway ${fast.totalKwh} should exceed flat ${flat.totalKwh}`);

const climbElev = Array.from({ length: 101 }, (_, i) => i * 5);
const climb = buildEnergyProfile(flatRoute(100, 60, { elevation: climbElev }), leaf);
assert.ok(climb.gainM > 400);
assert.ok(climb.totalKwh > flat.totalKwh, 'climb should cost more than flat');

const upDown = Array.from({ length: 101 }, (_, i) => (i < 50 ? i * 10 : (100 - i) * 10));
const pass = buildEnergyProfile(flatRoute(100, 60, { elevation: upDown }), leaf);
assert.ok(pass.totalKwh > flat.totalKwh, 'partial regen should not erase a climb');
assert.ok(pass.totalKwh < climb.totalKwh, 'descent should recover some energy');

const optimistic = {
  ...leaf,
  efficiencyKmPerKwh: 10,
  conservativeRangeKm: 200
};
const scaled = buildEnergyProfile(flatRoute(100, 60), optimistic);
assert.ok(scaled.scale > 1.05);
assert.ok(Math.abs(scaled.avgKmPerKwh - 5) < 0.4, `expected about 5 km/kWh, got ${scaled.avgKmPerKwh}`);

assert.equal(estimateChargeMinutes(10, 0, 50, 50, 40), 0);
assert.equal(estimateChargeMinutes(10, 10, null, 50, 40), null);
const minutes = estimateChargeMinutes(8, 16, 90, 50, 40);
assert.ok(minutes > 15 && minutes < 80, `minutes ${minutes}`);

const dealer = {
  name: '日産福岡販売 福岡東店',
  powerKw: 90,
  locationType: 'general',
  operatorClass: 'emp_operated',
  operatorName: 'e-Mobility Power',
  ai: {
    priceKnown: true,
    priceType: 'per_min',
    unitPrice: 55,
    sources: ['https://www.e-mobipower.co.jp/visitor-fee/'],
    checkedAt: '2026-10-20'
  }
};
assert.equal(classifyOperator(dealer), 'emp_partner');
const dealerPrice = resolveChargerPrice(dealer, { priceMaster: getDefaultPriceMaster() });
assert.equal(dealerPrice.unitPrice, null);
assert.equal(dealerPrice.caution, PARTNER_CAUTION);
assert.match(dealerPrice.caution, /2,970円\/回/);

const session = {
  ...dealer,
  ai: {
    priceKnown: true,
    priceType: 'per_session',
    unitPrice: 2970,
    sources: ['https://ev.gogo.gs/example'],
    checkedAt: '2026-10-20',
    hours: '10:00-19:00',
    hoursConflict: '9:30-18:30'
  }
};
const sessionPrice = resolveChargerPrice(session, {});
assert.equal(sessionPrice.unitPrice, 2970);
assert.equal(sessionPrice.priceType, 'per_session');
assert.equal(sessionPrice.hoursConflict, '9:30-18:30');
assert.equal(estimateSessionCost(sessionPrice, 20, 10), 2970);
const eff = effectiveYenPerMin(sessionPrice, 20, 10);
assert.ok(Math.abs(eff - 148.5) < 0.01);
assert.equal(formatUnitPrice(sessionPrice), '2970円/回');

const userWins = resolveChargerPrice(session, {
  userPrices: [{ name: '日産福岡販売 福岡東店', priceType: 'per_min', unitPrice: 44, savedAt: '2026-10-20T00:00:00Z' }]
});
assert.equal(userWins.source, 'user');
assert.equal(userWins.unitPrice, 44);

const emp = resolveChargerPrice({
  name: '海老名SA',
  powerKw: 50,
  locationType: 'general',
  operatorClass: 'emp_operated',
  operatorName: 'e-Mobility Power'
}, {});
assert.equal(emp.unitPrice, 55);
assert.equal(emp.provisional, true);
assert.ok(emp.sources[0].includes('e-mobipower.co.jp'));

const unsourced = normalizeResearchedCharger({
  name: '架空充電器',
  priceKnown: true,
  priceType: 'per_min',
  unitPrice: 55,
  operatorClass: 'other',
  sources: []
}, '2026-10-20');
assert.equal(unsourced.ai.priceKnown, false);

const eneos = resolveChargerPrice({
  name: 'ENEOS 某店',
  operatorClass: 'other',
  operatorName: 'ENEOS Charge Plus',
  powerKw: 50,
  locationType: 'general'
}, { priceMaster: getDefaultPriceMaster() });
assert.equal(eneos.source, 'master');
assert.equal(eneos.provisional, true);
assert.ok(eneos.unitPrice > 0);

const noToll = resolveToll({ hasToll: false, tollKm: 0 }, null);
assert.equal(noToll.tollYen, 0);
const unknownToll = resolveToll({ hasToll: true, tollKm: 40 }, { tollKnown: true, tollYen: 3000, sources: [] });
assert.equal(unknownToll.tollYen, null);

const tollWithGrounding = normalizeToll(
  { routeId: 'fast', tollKnown: true, tollYen: 4200, sources: [] },
  ['https://www.driveplaza.com/dp/SearchQuick']
);
assert.equal(tollWithGrounding.tollYen, 4200);
assert.ok(tollWithGrounding.sources.length);
const matchedAlt = matchToll(
  [{ routeId: 'fast', tollKnown: true, tollYen: 4200, sources: ['https://www.driveplaza.com/'] }],
  { key: 'fast-alt-1', requestKey: 'fast' }
);
assert.equal(matchedAlt.tollYen, 4200);

const long = flatRoute(180, 80, { highway: true });
long.key = 'fast';
long.requestKey = 'fast';
const local = flatRoute(210, 40, { highway: false });
local.key = 'local';
local.requestKey = 'local';
const mixed = flatRoute(190, 55, { highway: true });
mixed.key = 'mixed';
mixed.requestKey = 'mixed';
mixed.highwayRatio = 0.5;
mixed.roadSummary = '国道246号 → 東名高速道路';

const profile = buildEnergyProfile(long, leaf);
const reachKwh = leaf.batteryKwh * 0.8;
const reserve = leaf.safetyMarginKm * profile.whPerKm / 1000;
const reachKm = (reachKwh - reserve) / profile.whPerKm * 1000;
assert.ok(reachKm < 180, `expected a charge stop, reach ${reachKm}`);

function charger(km, extra) {
  const t = km / long.distanceKm;
  const lat = 35 + (long.distanceKm / 111) * t;
  return {
    name: extra.name,
    address: 'テスト',
    lat,
    lon: 139.1,
    powerKw: extra.powerKw,
    locationType: extra.locationType || 'highway',
    operatorClass: extra.operatorClass,
    operatorName: extra.operatorName || '',
    apps: 'e-Mobility Power',
    hours: '24時間',
    hoursConflict: extra.hoursConflict || '',
    ai: extra.ai
  };
}

const chargers = [
  charger(12, {
    name: '出発直後の安い充電器',
    powerKw: 50,
    operatorClass: 'other',
    operatorName: 'ENEOS Charge Plus',
    locationType: 'general',
    ai: {
      priceKnown: true,
      priceType: 'per_min',
      unitPrice: 10,
      sources: ['https://example.com/early'],
      checkedAt: '2026-10-20'
    }
  }),
  charger(Math.min(reachKm - 15, 100), {
    name: 'サンプルSA 急速',
    powerKw: 50,
    operatorClass: 'emp_operated',
    operatorName: 'e-Mobility Power',
    ai: {
      priceKnown: true,
      priceType: 'per_min',
      unitPrice: 77,
      sources: ['https://www.e-mobipower.co.jp/visitor-fee/'],
      checkedAt: '2026-10-20'
    }
  }),
  charger(Math.min(reachKm - 5, 120), {
    name: '日産サンプル販売 東店',
    powerKw: 90,
    locationType: 'general',
    operatorClass: 'emp_partner',
    ai: {
      priceKnown: true,
      priceType: 'per_session',
      unitPrice: 2970,
      sources: ['https://evsmart.net/example'],
      checkedAt: '2026-10-20',
      hours: '10:00-19:00',
      hoursConflict: '別ソース: 9:00-18:00'
    }
  })
];

const ctx = { priceMaster: getDefaultPriceMaster(), userPrices: [], researchCache: [] };
const item = prepareRouteItem(long, leaf, chargers, {
  tollKnown: true,
  tollYen: 4200,
  note: 'ETC通常',
  sources: ['https://www.driveplaza.com/']
}, ctx);
assert.equal(item.plans.cost.stops.length >= 1, true);
const stop = item.plans.cost.stops[0];
assert.ok(stop.arrivalRangeKm >= leaf.safetyMarginKm - 1);
assert.equal(stop.resolved.operatorClass === 'emp_partner' ? stop.resolved.unitPrice : stop.costYen != null, stop.resolved.operatorClass === 'emp_partner' ? 2970 : true);
assert.ok(stop.km < reachKm + 1);
assert.ok(stop.km > 40, `expected the low-SOC window, not an early top-up at km ${stop.km}`);

const localItem = prepareRouteItem(local, leaf, [], null, ctx);
const mixedItem = prepareRouteItem(mixed, leaf, chargers, { tollKnown: false, sources: [] }, ctx);
const fastItem = item;
const comparison = assembleComparison([fastItem, localItem, mixedItem]);
assert.deepEqual(comparison.patterns.map((p) => p.id), ['cheapest', 'fastest', 'highway', 'local']);
assert.equal(comparison.patterns.find((p) => p.id === 'local').toll.tollYen, 0);
assert.ok(comparison.recommendation.length > 10);
const partnerStop = comparison.patterns.flatMap((p) => p.stops).find((s) => s.resolved.operatorClass === 'emp_partner');
if (partnerStop) {
  assert.equal(partnerStop.resolved.unitPrice, 2970);
  assert.ok(partnerStop.warnings.some((w) => w.includes('実質')));
}

const unnamed = charger(Math.min(reachKm - 20, 90), {
  name: '出力不明の急速',
  powerKw: null,
  operatorClass: 'unknown',
  ai: { priceKnown: false, priceType: 'unknown', unitPrice: null, sources: [] }
});
const unnamedItem = prepareRouteItem(long, leaf, [unnamed], { tollKnown: true, tollYen: 1000, sources: ['https://www.driveplaza.com/'] }, ctx);
const unnamedStop = unnamedItem.plans.cost.stops[0];
assert.ok(unnamedStop, 'a stop is chosen even without a listed kW');
assert.equal(unnamedStop.powerAssumed, true);
assert.ok(unnamedStop.minutes > 0);
assert.equal(unnamedStop.costYen, null);
assert.ok(unnamedItem.plans.cost.chargeMinutes > 0);
assert.equal(unnamedItem.plans.cost.chargeYen, null);
const unnamedComparison = assembleComparison([unnamedItem, localItem, mixedItem]);
assert.ok(unnamedComparison.patterns.some((pattern) => pattern.totalTimeSec != null && pattern.chargeMinutes > 0));

const via = routeViaLine([
  { name: '津和崎潤線', lengthKm: 1.2 },
  { name: '国道202号', lengthKm: 5 },
  { name: 'E35', lengthKm: 20 },
  { name: '福岡都市高速2号太宰府線', lengthKm: 4 },
  { name: 'E3', lengthKm: 15 },
  { name: 'E34', lengthKm: 40 },
  { name: 'E10', lengthKm: 30 }
], [{ name: '国道のENEOS' }]);
assert.equal(via, '国道202号→西九州道→福岡都市高速2号太宰府→九州道→大分道→東九州道 · 国道のENEOS');
const google = googleDirectionsUrl({
  origin: { lat: 33.57815, lon: 130.21301 },
  destination: { lat: 32.55019, lon: 131.68136 },
  stops: [{ lat: 33.25, lon: 131.0, name: '国道のENEOS' }]
});
const apple = appleDirectionsUrl({
  origin: { lat: 33.57815, lon: 130.21301 },
  destination: { lat: 32.55019, lon: 131.68136 },
  stops: [{ lat: 33.25, lon: 131.0 }]
});
assert.match(google, /^https:\/\/www\.google\.com\/maps\/dir\/\?/);
assert.match(decodeURIComponent(google), /33\.25000,131\.00000/);
assert.match(apple, /^https:\/\/maps\.apple\.com\/\?saddr=/);
assert.match(apple, /\+to:/);
const localUrl = googleDirectionsUrl({
  origin: { lat: 33.5, lon: 130.2 },
  destination: { lat: 32.5, lon: 131.6 },
  stops: [],
  avoidTolls: true
});
assert.match(localUrl, /avoid=tolls/);

console.log('route-model tests ok');
console.log('flat', flat.totalKwh.toFixed(2), 'fast', fast.totalKwh.toFixed(2), 'climb', climb.totalKwh.toFixed(2), 'pass', pass.totalKwh.toFixed(2));
console.log('reachKm', reachKm.toFixed(1), 'stops', item.plans.cost.stops.map((s) => `${s.name}@${s.km.toFixed(0)} ${s.minutes}min ${s.costYen}`).join(', '));
console.log(comparison.recommendation);
