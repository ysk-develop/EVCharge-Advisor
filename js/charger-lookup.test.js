import assert from 'node:assert/strict';
import {
  answerText,
  chargersFromOverpass,
  mergeChargerPrices,
  parseModelJson,
  sampleRoutePoints
} from './charger-lookup.js';
import { assembleLookup, researchRoutes } from './route-research.js';

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
assert.ok(points.length <= 6);

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
assert.ok(calls.some((url) => url.includes('overpass-api.de')));
assert.ok(calls.some((url) => url.includes('/models/gemini-2.5-flash:')));
assert.equal(looked.chargers.length, 1);
assert.equal(looked.chargers[0].ai.unitPrice, 77);
assert.equal(looked.tolls[0].tollYen, 320);
assert.equal(looked.debug.groundingCount, 2);
assert.equal(looked.emptyMessage, '');

console.log('charger lookup tests ok');
