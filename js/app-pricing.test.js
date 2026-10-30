import assert from 'node:assert/strict';
import { extractSpotFacts, quoteApps } from './app-pricing.js';
import { getDefaultPriceMaster } from './price-master.js';
import { prepareRouteItem } from './route-model.js';

const URL = 'https://www.evsmart.net/spot/fukuoka/l401307/q401315/v35709';
const page = [
  '2025/12/23よりeMPスポットとして運用',
  '認証システム:ENEOS Charge Plus',
  'ENEOS Charge Plus 会員 46.2円/分 非会員 49.5円/分'
].join('\n');
const facts = extractSpotFacts(page, URL);
assert.equal(facts.empSpot, true);
assert.deepEqual(facts.authSystems, ['ENEOS Charge Plus']);
assert.ok(facts.usableApps.some((row) => row.appId === 'eneos' && row.source === URL));
assert.ok(facts.usableApps.some((row) => row.appId === 'emp'));
assert.ok(facts.usableApps.some((row) => row.appId === 'nissan'));
assert.equal(facts.appPrices.find((row) => row.member === false).unitPrice, 49.5);
assert.equal(facts.appPrices.find((row) => row.member === true).unitPrice, 46.2);

const colonPage = [
  '2025/12/23よりeMPスポットとして運用。',
  '認証システム:ENEOS Charge Plus',
  'ENEOS Charge Plus:1分/46.2円 (会員)',
  'ENEOS Charge Plus:1分/49.5円 (非会員)'
].join('\n');
const colon = extractSpotFacts(colonPage, URL);
assert.equal(colon.appPrices.find((row) => row.member === false && row.appId === 'eneos').unitPrice, 49.5);
assert.equal(colon.appPrices.find((row) => row.member === true && row.appId === 'eneos').unitPrice, 46.2);

const visitorPage = extractSpotFacts('2024/01/31よりeMPスポットとして運用。\n充電1分あたり77円\n充電1分99円', 'https://www.evsmart.net/spot/example');
assert.ok(visitorPage.appPrices.some((row) => row.appId === 'emp' && row.unitPrice === 77 && row.priceType === 'per_min'));
assert.ok(visitorPage.appPrices.some((row) => row.appId === 'emp' && row.unitPrice === 99 && row.priceType === 'per_min'));

const yumetown = {
  name: 'ゆめタウン博多',
  powerKw: 50,
  locationType: 'general',
  operatorClass: 'other',
  ...facts
};
const master = getDefaultPriceMaster();
const ctx = { selectedApps: ['emp', 'eneos', 'nissan'], memberApps: [], priceMaster: master, userPrices: [] };
const visitor = quoteApps(yumetown, ctx, { minutes: 20, kwhAdded: 10 });
assert.equal(visitor.chosen.appId, 'eneos');
assert.equal(visitor.chosen.unitPrice, 49.5);
assert.equal(visitor.chosen.assumed, false);
assert.equal(visitor.chosen.costYen, 990);
const emp = visitor.options.find((row) => row.appId === 'emp');
assert.equal(emp.assumed, true);
assert.equal(emp.unitPrice, 55);

const member = quoteApps(yumetown, { ...ctx, memberApps: ['eneos'] }, { minutes: 20, kwhAdded: 10 });
assert.equal(member.chosen.unitPrice, 46.2);

const saved = quoteApps(yumetown, {
  ...ctx,
  userPrices: [{ name: 'ゆめタウン博多', priceType: 'per_min', unitPrice: 30 }]
}, { minutes: 20, kwhAdded: 10 });
assert.equal(saved.chosen.label, '保存');
assert.equal(saved.chosen.unitPrice, 30);

const route = {
  key: 'fast',
  requestKey: 'fast',
  distanceKm: 180,
  durationSec: 8000,
  hasToll: true,
  hasHighway: true,
  hasFerry: false,
  tollKm: 100,
  highwayKm: 160,
  highwayRatio: 0.9,
  maneuvers: [{ lengthKm: 180, timeSec: 8000, name: '東九州自動車道', highway: true, toll: true }],
  roadSummary: '東九州自動車道',
  shape: Array.from({ length: 16 }, (_, i) => [33.5 - i * 0.02, 130.4 + i * 0.03]),
  elevation: Array.from({ length: 181 }, () => 20),
  elevationIntervalM: 1000
};
const vehicle = {
  batteryKwh: 40, socPercent: 80, efficiencyKmPerKwh: 6.5, conservativeRangeKm: 220,
  maxDcKw: 50, safetyMarginKm: 25
};
const dealer = {
  name: '日産 延岡店',
  lat: route.shape[4][0],
  lon: route.shape[4][1],
  powerKw: 44,
  locationType: 'general',
  operatorClass: 'emp_partner',
  usableApps: [{ appId: 'nissan', source: 'https://ev.gogo.gs/dealer' }],
  appPrices: [{ appId: 'nissan', member: false, priceType: 'per_session', unitPrice: 2970, source: 'https://ev.gogo.gs/dealer' }]
};
const cheap = {
  name: '国道のENEOS',
  lat: route.shape[5][0],
  lon: route.shape[5][1],
  powerKw: 50,
  locationType: 'highway',
  empSpot: true,
  usableApps: [{ appId: 'eneos', source: URL }],
  appPrices: [{ appId: 'eneos', member: false, priceType: 'per_min', unitPrice: 49.5, source: URL }]
};
const item = prepareRouteItem(route, vehicle, [dealer, cheap], null, ctx);
const stop = item.plans.cost.stops[0];
assert.ok(stop, 'expected a charge stop');
assert.equal(stop.name, '国道のENEOS');
assert.equal(stop.chosenApp.appId, 'eneos');
assert.ok(stop.costYen < 2970);
assert.ok(item.plans.cost.chargeMinutes > 0);
assert.equal(item.plans.highway.stops[0].name, '国道のENEOS');

console.log('app pricing tests ok', stop.costYen);
