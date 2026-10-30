import assert from 'node:assert/strict';
import {
  answerText,
  chargersFromOverpass,
  describeNetError,
  fetchOsmChargers,
  mergeChargerPrices,
  parseModelJson,
  sampleRoutePoints
} from './charger-lookup.js';
import { haversineKm } from './geo.js';
import { assembleLookup, researchRoutes, researchTollsAndStopPrices } from './route-research.js';

const thoughtResponse = {
  candidates: [{
    content: {
      parts: [
        { thought: true, text: 'SAを検索しよう。料金は書かない。' },
        { text: '調べました。\n```json\n{"chargers":[{"name":"糸島PA 急速","lat":33.59,"lon":130.22,"powerKw":50,"priceType":"per_min","unitPrice":77,"operatorClass":"emp_operated","sources":["https://ev.gogo.gs/itoshima"]}],"tolls":[{"routeId":"fast","tollYen":320,"sources":["https://www.driveplaza.com/toll"]}]}\n```' }
      ]
    },
    groundingMetadata: {
      groundingChunks: [
        { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'GoGoEV' } },
        { web: { uri: 'https://ev.gogo.gs/itoshima', title: '糸島PA' } }
      ]
    }
  }]
};

const text = answerText(thoughtResponse);
assert.doesNotMatch(text, /SAを検索しよう/);
assert.match(text, /糸島PA/);
const parsed = parseModelJson(text);
assert.equal(parsed.ok, true);
assert.equal(parsed.value.chargers[0].unitPrice, 77);
assert.equal(parsed.value.tolls[0].tollYen, 320);

const partial = parseModelJson('途中で切れました {"chargers":[{"name":"今宿急速","unitPrice":55,"priceType":"per_min","sources":["https://evsmart.net/a"]}, {"name":"欠け');
assert.equal(partial.ok, true);
assert.equal(partial.value.chargers.length, 1);
assert.equal(partial.value.chargers[0].name, '今宿急速');

const prose = answerText({
  candidates: [{
    content: { parts: [{ text: 'この区間は短いため、具体的な充電器名は確認できませんでした。' }] },
    groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/page', title: '案内' } }] }
  }]
});
const empty = assembleLookup({
  osmChargers: [],
  grounded: { rawText: prose, grounding: ['https://example.com/page'], error: '' },
  checkedAt: '2026-10-21'
});
assert.equal(empty.chargers.length, 0);
assert.equal(empty.emptyMessage, '検索は成功したが充電器を読み取れませんでした。');
assert.equal(empty.debug.groundingCount, 1);
assert.match(empty.debug.rawText, /具体的な充電器名は確認できませんでした/);

const osm = chargersFromOverpass([
  {
    type: 'node',
    id: 1,
    lat: 33.6015,
    lon: 130.4204,
    tags: { amenity: 'charging_station', name: '東区スポット', 'socket:chademo': '2', 'socket:chademo:output': '50', operator: 'e-Mobility Power' }
  },
  {
    type: 'node',
    id: 2,
    lat: 33.6015,
    lon: 130.4204,
    tags: { amenity: 'charging_station', name: '重複' }
  }
]);
assert.equal(osm.length, 1);
assert.equal(osm[0].powerKw, 50);
assert.equal(osm[0].operatorClass, 'emp_operated');
assert.equal(osm[0].ai.priceKnown, false);

const withMap = assembleLookup({
  osmChargers: osm,
  grounded: { rawText: prose, grounding: ['https://example.com/page'], error: '' },
  checkedAt: '2026-10-21'
});
assert.equal(withMap.chargers.length, 1);
assert.equal(withMap.chargers[0].name, '東区スポット');
assert.match(withMap.priceMessage, /検索は成功したが充電器の料金を読み取れませんでした/);

const merged = mergeChargerPrices(osm, [{
  name: '別の表記',
  lat: 33.602,
  lon: 130.421,
  powerKw: null,
  operatorClass: 'emp_operated',
  operatorName: 'e-Mobility Power',
  ai: { priceKnown: true, priceType: 'per_min', unitPrice: 77, sources: ['https://ev.gogo.gs/itoshima'], priceNote: '' }
}]);
assert.equal(merged.length, 1);
assert.equal(merged[0].ai.unitPrice, 77);
assert.equal(merged[0].powerKw, 50);

const points = sampleRoutePoints([
  { shape: [[33.62, 130.42], [33.60, 130.32], [33.58, 130.21]] }
]);
assert.ok(points.length >= 2);
assert.ok(points.length <= 8);

assert.equal(describeNetError(new TypeError('Load failed'), '地図の充電器検索'), '地図の充電器検索に失敗しました（通信エラー）。');
assert.match(describeNetError({ name: 'AbortError', message: 'The operation was aborted.' }, '通行料金検索'), /通行料金検索が時間内に終わりませんでした/);

const longShape = [[33.578, 130.213]];
for (let i = 1; i <= 30; i += 1) longShape.push([33.578, 130.213 + i * 0.11]);
const longVehicle = {
  batteryKwh: 40, socPercent: 80, efficiencyKmPerKwh: 6, conservativeRangeKm: 220,
  safetyMarginKm: 25, maxDcKw: 50, connector: 'CHAdeMO', hasEtc: true
};
const longRoute = { key: 'fast', distanceKm: 300, hasToll: true, roadSummary: '高速道路', shape: longShape, maneuvers: [] };
const longPoints = sampleRoutePoints([longRoute], 25, longVehicle);
const farKm = Math.max(...longPoints.map((point) => haversineKm(33.578, 130.213, point.lat, point.lon)));
assert.ok(farKm > 150, `expected a point near where the battery runs low, got ${farKm.toFixed(0)} km`);

const calls = [];
globalThis.fetch = async (url, init) => {
  const target = String(url);
  calls.push(target);
  if (target.includes('overpass-api.de')) {
    return {
      ok: true,
      json: async () => ({
        elements: [{
          type: 'node',
          id: 9,
          lat: 33.59,
          lon: 130.22,
          tags: { amenity: 'charging_station', name: '糸島PA 急速', 'socket:chademo': '1', 'socket:chademo:output': '50' }
        }]
      })
    };
  }
  const body = JSON.parse(init.body);
  assert.equal(body.generationConfig.responseSchema, undefined);
  assert.equal(body.generationConfig.responseMimeType, undefined);
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.deepEqual(body.tools, [{ google_search: {} }]);
  return { ok: true, json: async () => thoughtResponse };
};
const looked = await researchRoutes('test-key', 'gemini-flash-latest', [
  { key: 'fast', distanceKm: 28, hasToll: true, roadSummary: '都市高速', shape: [[33.62, 130.42], [33.59, 130.22]] }
], {
  batteryKwh: 40, socPercent: 80, conservativeRangeKm: 220, maxDcKw: 50, connector: 'CHAdeMO', safetyMarginKm: 25, hasEtc: true
}, 'eMP', '2026-10-21T07:00', () => {});
assert.equal(calls.some((url) => url.includes('overpass-api.de')), false);
assert.ok(calls.some((url) => url.includes('/models/gemini-2.5-flash:')));
assert.equal(looked.chargers.length, 1);
assert.equal(looked.chargers[0].ai.unitPrice, 77);
assert.equal(looked.tolls[0].tollYen, 320);
assert.equal(looked.debug.groundingCount, 2);
assert.equal(looked.emptyMessage, '');

globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.includes('overpass')) throw new TypeError('Load failed');
  const prompt = JSON.parse(init.body).contents[0].parts[0].text;
  if (prompt.includes('片道通行料金だけ')) {
    return {
      ok: true,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: '{"tolls":[{"routeId":"fast","tollYen":4200,"sources":["https://www.driveplaza.com/nobeoka"]}]}' }] },
          groundingMetadata: { groundingChunks: [{ web: { uri: 'https://www.driveplaza.com/nobeoka', title: '料金' } }] }
        }]
      })
    };
  }
  throw new TypeError('Load failed');
};
const isolated = await researchTollsAndStopPrices('test-key', 'gemini-2.5-flash', [
  { key: 'fast', distanceKm: 28, hasToll: true, roadSummary: '都市高速', shape: [[33.62, 130.42], [33.59, 130.22]] }
], [{ name: '東浜急速', lat: 33.6, lon: 130.32, operatorName: '', powerKw: null }], longVehicle, 'eMP', '2026-10-21T07:00');
assert.equal(isolated.tolls.find((toll) => toll.routeId === 'fast').tollYen, 4200);
assert.equal(isolated.tollMessage, '');
assert.match(isolated.priceMessage, /料金検索に失敗しました（通信エラー）/);
assert.match(isolated.priceMessage, /充電時間は車両と充電器の出力から計算しています/);
assert.equal(isolated.debugSteps.find((step) => step.name === '通行料金検索').ok, true);

globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes('overpass-api.de')) throw new TypeError('Load failed');
  if (target.includes('kumi.systems')) {
    return {
      ok: true,
      json: async () => ({
        elements: [{
          type: 'node', id: 3, lat: 33.2, lon: 131.2,
          tags: { amenity: 'charging_station', name: '延岡SA', 'socket:chademo': '1', 'socket:chademo:output': '50' }
        }]
      })
    };
  }
  throw new Error(`unexpected ${target}`);
};
const mirrored = await fetchOsmChargers([longRoute], { timeoutMs: 8000, vehicle: longVehicle });
assert.equal(mirrored.chargers[0].name, '延岡SA');
assert.match(mirrored.attempts.join('\n'), /Load failed/);

console.log('charger lookup tests ok');
