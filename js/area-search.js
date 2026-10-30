/**
 * One grounded search per charge area, then a price follow-up only if needed.
 * A comparison stays near 10 grounded calls. Results are cached for a few days.
 */
import { generateSearch } from './gemini-api.js';
import { answerText, describeNetError, parseModelJson } from './charger-lookup.js';
import { haversineKm } from './geo.js';
import { loadChargerCatalog } from './charger-catalog.js';

const CACHE_KEY = 'evca_area_cache_v1';
const CACHE_MS = 3 * 24 * 60 * 60 * 1000;
export const MAX_GROUNDED_CALLS = 10;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function cacheStore() {
  try {
    if (typeof localStorage === 'undefined') return {};
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function cacheWrite(store) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(CACHE_KEY, JSON.stringify(store));
  } catch {
    /* quota */
  }
}

export function areaCacheId(area) {
  const roads = (area.roads || [area.road]).filter(Boolean).slice(0, 2).join('|');
  return `${Number(area.lat).toFixed(2)},${Number(area.lon).toFixed(2)}|${area.highway ? 'hw' : 'rd'}|${roads}`;
}

export function readAreaCache(id) {
  const row = cacheStore()[id];
  if (!row || Date.now() - row.at > CACHE_MS) return null;
  return row.candidates || null;
}

export function writeAreaCache(id, candidates) {
  const store = cacheStore();
  store[id] = { at: Date.now(), candidates };
  const ids = Object.keys(store);
  if (ids.length > 40) {
    ids.sort((a, b) => (store[a].at || 0) - (store[b].at || 0));
    ids.slice(0, ids.length - 40).forEach((key) => { delete store[key]; });
  }
  cacheWrite(store);
}

function takeCall(budget) {
  if (budget.used >= budget.max) return false;
  budget.used += 1;
  return true;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

function inJapan(lat, lon) {
  return lat >= 24 && lat <= 46 && lon >= 122 && lon <= 154;
}

function areaPrompt(area, place) {
  const roads = (area.roads || []).filter(Boolean).join(' / ') || 'この地点の道路';
  const where = place ? `${place}、` : '';
  const kind = area.highway
    ? `${roads} のSA/PAなど高速道路上`
    : `${roads} 沿いの一般道・国道`;
  return `次の地点から約15km以内の急速充電器を最大3件、EVsmart（evsmart.net/spot）とGoGoEV（ev.gogo.gs）のスポットページだけを見て答えてください。
${where}${kind}。緯度${area.lat.toFixed(3)} 経度${area.lon.toFixed(3)}。
各ページから、認証システム、eMPスポットかどうか、アプリごとの会員料金と非会員料金、出典URLを取り出してください。
回答はJSONだけ。ページに無い単価は書かない。
{"chargers":[{"name":"","address":"","lat":0,"lon":0,"powerKw":50,"connector":"CHAdeMO","hours":"","locationType":"general","empSpot":false,"authSystems":["ENEOS Charge Plus"],"usableApps":[{"appId":"eneos","source":"https://www.evsmart.net/spot/example"}],"appPrices":[{"appId":"eneos","member":false,"priceType":"per_min","unitPrice":49.5,"source":"https://www.evsmart.net/spot/example"},{"appId":"eneos","member":true,"priceType":"per_min","unitPrice":46.2,"source":"https://www.evsmart.net/spot/example"}]}]}
appId は emp / eneos / terra / dmm / enechange / powerx / nissan / flash / piyo。
eMPスポットなら emp と nissan を usableApps に入れる。認証システムに書いてあるアプリも入れる。`;
}

function pricePrompt(charger) {
  return `「${charger.name}」の EVsmart（evsmart.net/spot）か GoGoEV（ev.gogo.gs）のページだけを開き、認証システム、eMPスポットか、アプリごとの会員・非会員料金と営業時間を取り出してください。
回答はJSONだけ。ページに無い単価は書かない。
{"name":"${charger.name}","hours":"","empSpot":false,"authSystems":[],"usableApps":[{"appId":"eneos","source":"https://www.evsmart.net/spot/example"}],"appPrices":[{"appId":"eneos","member":false,"priceType":"per_min","unitPrice":49.5,"source":"https://www.evsmart.net/spot/example"}]}`;
}

export function candidatesFromText(text, area) {
  const parsed = parseModelJson(text);
  const rows = parsed.value?.chargers || (parsed.value?.name ? [parsed.value] : []);
  return rows.slice(0, 3).map((raw) => toCharger(raw, area)).filter((row) => row?.name);
}

function toCharger(raw, area) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  const hasPoint = inJapan(lat, lon);
  const sources = (raw.sources || []).map(String).filter((url) => /^https?:\/\//i.test(url));
  const priceType = ['per_min', 'per_kwh', 'per_session', 'unknown'].includes(raw.priceType) ? raw.priceType : 'unknown';
  const unit = Number(raw.unitPrice);
  const priceKnown = sources.length > 0 && Number.isFinite(unit) && priceType !== 'unknown';
  const operatorClass = ['emp_operated', 'emp_partner', 'other', 'unknown'].includes(raw.operatorClass) ? raw.operatorClass : 'unknown';
  const locationType = raw.locationType === 'highway' || raw.locationType === 'general'
    ? raw.locationType
    : (area?.highway ? 'highway' : 'general');
  const pointLat = hasPoint ? lat : area.lat;
  const pointLon = hasPoint ? lon : area.lon;
  return {
    name: String(raw.name || '').slice(0, 80),
    address: String(raw.address || '').slice(0, 120),
    lat: pointLat,
    lon: pointLon,
    coordNote: hasPoint ? '' : '座標は検索地点の目安です。',
    powerKw: Number(raw.powerKw) > 0 ? Number(raw.powerKw) : null,
    locationType,
    operatorClass,
    operatorName: String(raw.operator || raw.operatorName || '').slice(0, 80),
    connector: String(raw.connector || '').slice(0, 40),
    empSpot: Boolean(raw.empSpot),
    authSystems: (raw.authSystems || []).map(String).slice(0, 6),
    usableApps: (raw.usableApps || []).map((row) => ({
      appId: String(row.appId || ''),
      source: String(row.source || ''),
      evidence: String(row.evidence || '')
    })).filter((row) => row.appId),
    appPrices: (raw.appPrices || []).map((row) => ({
      appId: String(row.appId || ''),
      member: row.member === true ? true : row.member === false ? false : null,
      priceType: row.priceType || 'unknown',
      unitPrice: Number(row.unitPrice),
      source: String(row.source || '')
    })).filter((row) => row.appId && Number.isFinite(row.unitPrice) && row.source),
    hours: String(raw.hours || '').slice(0, 160),
    hoursConflict: '',
    routeId: '',
    offKm: haversineKm(pointLat, pointLon, area.lat, area.lon),
    priceType,
    ai: {
      priceKnown,
      priceType,
      unitPrice: priceKnown ? unit : null,
      priceNote: '',
      sources,
      hours: String(raw.hours || '').slice(0, 160),
      hoursConflict: '',
      checkedAt: todayIso()
    }
  };
}

async function defaultSearch(apiKey, model, prompt, timeoutMs) {
  const searched = await generateSearch(apiKey, model, {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } }
  }, { timeoutMs, allowRetry: false });
  return { text: answerText(searched.data), notice: searched.notice || '' };
}

async function placeName(area) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const url = `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${area.lat}&lon=${area.lon}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return '';
    const data = await res.json();
    return data?.results?.muniNm || data?.results?.lv01Nm || '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function osmHint(area) {
  try {
    const catalog = await loadChargerCatalog();
    const near = catalog.near(area.lat, area.lon, 15);
    const row = near.find((charger) => charger.dc) || near[0];
    if (!row) return null;
    return {
      ...row,
      fallback: true,
      preferred: true,
      address: row.address || ''
    };
  } catch {
    return null;
  }
}

export async function researchAreas(options) {
  const {
    apiKey,
    model,
    areas,
    vehicle,
    onStatus,
    search = defaultSearch,
    timeoutMs = 22000,
    concurrency = 2
  } = options;
  const budget = { max: MAX_GROUNDED_CALLS, used: 0 };
  const notes = [];
  const texts = [];
  let notice = '';
  const chosen = [];

  const results = await mapPool(areas, concurrency, async (area, index) => {
    const id = areaCacheId(area);
    const cached = readAreaCache(id);
    if (cached) {
      if (onStatus) onStatus(`充電地点 ${index + 1}/${areas.length} は数日以内の検索結果を使います`);
      return { area, candidates: cached, cached: true, error: '' };
    }
    if (!takeCall(budget)) {
      return { area, candidates: [], cached: false, error: '1回の比較で使う検索は10回までです。' };
    }
    if (onStatus) onStatus(`充電地点 ${index + 1}/${areas.length}（${(area.roads || []).join(' / ') || '経路上'}）を検索しています`);
    try {
      const place = await placeName(area);
      const found = await search(apiKey, model, areaPrompt({ ...area, roads: area.roads }, place), timeoutMs);
      if (found.notice) notice = found.notice;
      texts.push(found.text);
      const candidates = candidatesFromText(found.text, area);
      if (candidates.length) writeAreaCache(id, candidates);
      return { area, candidates, cached: false, error: candidates.length ? '' : '検索は成功しましたが、この地点の充電器を読み取れませんでした。' };
    } catch (err) {
      const message = describeNetError(err, '充電器検索');
      notes.push(message);
      return { area, candidates: [], cached: false, error: message };
    }
  });

  for (const result of results) {
    let rows = (result.candidates || []).slice(0, 3);
    if (!rows.length) {
      const hint = await osmHint(result.area);
      if (hint) {
        rows = [hint];
        notes.push('一部の地点は検索できず、地図の位置だけを使いました。');
      } else if (result.error) notes.push(result.error);
    }
    const areaHasPrice = rows.some((row) => (row.appPrices || []).length > 0);
    for (const row of rows) {
      const hasPagePrice = (row.appPrices || []).length > 0;
      if (!areaHasPrice && !row.fallback && !hasPagePrice && takeCall(budget)) {
        if (onStatus) onStatus(`${row.name} の料金ページを確認しています`);
        try {
          const priced = await search(apiKey, model, pricePrompt(row), timeoutMs);
          if (priced.notice) notice = priced.notice;
          texts.push(priced.text);
          const parsed = parseModelJson(priced.text);
          const extra = parsed.value?.chargers?.[0] || parsed.value;
          if (extra) {
            const updated = toCharger({ ...extra, name: row.name, lat: row.lat, lon: row.lon }, result.area);
            if (updated?.appPrices?.length) row.appPrices = updated.appPrices;
            if (updated?.usableApps?.length) row.usableApps = updated.usableApps;
            if (updated?.empSpot) row.empSpot = true;
            if (updated?.hours) row.hours = updated.hours;
          }
        } catch (err) {
          notes.push(describeNetError(err, '料金検索'));
        }
      }
      chosen.push(row);
    }
  }

  return {
    chargers: chosen,
    groundedCalls: budget.used,
    notes: notes.filter(Boolean).join('\n'),
    researchText: texts.filter(Boolean).join('\n\n'),
    modelNotice: notice,
    cachedAreas: results.filter((row) => row.cached).length,
    searchedAreas: results.length
  };
}
