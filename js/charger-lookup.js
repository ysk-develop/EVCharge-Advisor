/**
 * Charger locations come from OpenStreetMap. Gemini search is only asked
 * for prices and tolls, in a compact JSON-in-text answer.
 */

import { haversineKm } from './geo.js';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

export function sampleRoutePoints(routes, spacingKm = 10) {
  const picked = [];
  const consider = (lat, lon) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (picked.some((point) => haversineKm(point.lat, point.lon, lat, lon) < 4)) return;
    picked.push({ lat, lon });
  };
  for (const route of routes || []) {
    const shape = route.shape || [];
    if (!shape.length) continue;
    consider(shape[0][0], shape[0][1]);
    let prev = shape[0];
    let walked = 0;
    for (let i = 1; i < shape.length; i += 1) {
      walked += haversineKm(prev[0], prev[1], shape[i][0], shape[i][1]);
      prev = shape[i];
      if (walked >= spacingKm) {
        consider(prev[0], prev[1]);
        walked = 0;
        if (picked.length >= 6) return picked;
      }
    }
    const last = shape[shape.length - 1];
    consider(last[0], last[1]);
    if (picked.length >= 6) break;
  }
  return picked.slice(0, 6);
}

export function buildOverpassQuery(points) {
  const clauses = points.map((point) => (
    `node["amenity"="charging_station"](around:2500,${point.lat.toFixed(5)},${point.lon.toFixed(5)});`
  )).join('');
  return `[out:json][timeout:10];(${clauses});out tags;`;
}

function socketOn(tags, key) {
  const value = tags[key];
  if (value == null || value === '' || value === 'no' || value === '0') return false;
  return true;
}

function operatorClassFromTags(tags) {
  const blob = `${tags.operator || ''} ${tags.network || ''} ${tags.brand || ''} ${tags.name || ''}`;
  const dealer = /日産|ホンダ|Honda|三菱|ディーラー|販売/.test(blob);
  if (/e-?mobility|イーモビリティ|eMP/i.test(blob)) return dealer ? 'emp_partner' : 'emp_operated';
  if (dealer) return 'emp_partner';
  if (tags.operator || tags.network || tags.brand) return 'other';
  return 'unknown';
}

export function chargersFromOverpass(elements, checkedAt) {
  const out = [];
  const seen = new Set();
  for (const element of elements || []) {
    const tags = element.tags || {};
    const lat = Number(element.lat ?? element.center?.lat);
    const lon = Number(element.lon ?? element.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const chademo = socketOn(tags, 'socket:chademo');
    const ccs = socketOn(tags, 'socket:ccs') || socketOn(tags, 'socket:type2_combo');
    const output = Number(tags['socket:chademo:output'] || tags['socket:ccs:output'] || tags['socket:type2_combo:output']);
    const powerKw = Number.isFinite(output) && output > 0 ? output : null;
    const acOnly = !chademo && !ccs && (socketOn(tags, 'socket:type2') || socketOn(tags, 'socket:schuko') || socketOn(tags, 'socket:j1772'));
    const connectorNote = chademo ? 'CHAdeMO' : ccs ? 'CCS' : acOnly ? '普通充電の可能性' : 'コネクタは地図に未記載';
    const address = [tags['addr:state'], tags['addr:city'], tags['addr:suburb'], tags['addr:street']].filter(Boolean).join('');
    out.push({
      name: String(tags.name || `充電スポット（${lat.toFixed(3)}, ${lon.toFixed(3)}）`).slice(0, 80),
      address: address.slice(0, 120),
      lat,
      lon,
      powerKw,
      locationType: /SA|PA|高速|サービスエリア/.test(`${tags.name || ''} ${tags.operator || ''}`) ? 'highway' : 'unknown',
      operatorClass: operatorClassFromTags(tags),
      operatorName: String(tags.operator || tags.network || tags.brand || '').slice(0, 80),
      apps: connectorNote,
      hours: String(tags.opening_hours || '').slice(0, 200),
      hoursConflict: '',
      routeId: '',
      osmId: element.id || null,
      dc: Boolean(chademo || ccs || (powerKw != null && powerKw >= 20)),
      ai: {
        priceKnown: false,
        priceType: 'unknown',
        unitPrice: null,
        priceNote: connectorNote,
        sources: [],
        hours: String(tags.opening_hours || '').slice(0, 200),
        hoursConflict: '',
        checkedAt: checkedAt || ''
      }
    });
  }
  out.sort((a, b) => Number(b.dc) - Number(a.dc));
  return out.slice(0, 16);
}

export async function fetchOsmChargers(routes, { timeoutMs = 12000, checkedAt = '' } = {}) {
  const points = sampleRoutePoints(routes);
  if (!points.length) return { chargers: [], error: 'ルート座標がありません', points };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
      },
      body: `data=${encodeURIComponent(buildOverpassQuery(points))}`,
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`地図検索 HTTP ${res.status}`);
    const data = await res.json();
    return { chargers: chargersFromOverpass(data.elements, checkedAt), error: '', points };
  } catch (err) {
    const message = err?.name === 'AbortError' ? '地図検索が時間内に終わりませんでした。' : (err?.message || '地図検索に失敗しました');
    return { chargers: [], error: message, points };
  } finally {
    clearTimeout(timer);
  }
}

export function answerText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((part) => part && typeof part.text === 'string' && !part.thought)
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export function collectSourceUrls(data) {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const urls = [];
  for (const chunk of chunks) {
    if (chunk.web?.uri) urls.push(chunk.web.uri);
  }
  return [...new Set(urls)];
}

function objectsIn(text) {
  const found = [];
  const re = /\{[^{}]*\}/g;
  let match = re.exec(text);
  while (match) {
    try {
      found.push(JSON.parse(match[0]));
    } catch {
      /* 欠けたオブジェクトは飛ばす */
    }
    match = re.exec(text);
  }
  return found;
}

function salvage(text) {
  const chargerAt = text.search(/"chargers"\s*:/);
  const tollAt = text.search(/"tolls"\s*:/);
  const chargers = chargerAt >= 0 ? objectsIn(text.slice(chargerAt)) : [];
  const tolls = tollAt >= 0 ? objectsIn(text.slice(tollAt, chargerAt > tollAt ? chargerAt : undefined)) : [];
  const named = chargers.filter((row) => row.name || row.unitPrice != null || row.lat != null);
  if (!named.length && !tolls.length) return null;
  return { chargers: named, tolls };
}

export function parseModelJson(text) {
  const source = String(text || '');
  if (!source.trim()) return { ok: false, error: '本文が空です', value: null };
  const fenced = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1]);
  const chunks = fenced.length ? fenced : [source];
  let lastError = 'JSONが見つかりません';
  for (const chunk of chunks) {
    const start = chunk.indexOf('{');
    const end = chunk.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      return { ok: true, error: '', value: JSON.parse(chunk.slice(start, end + 1)) };
    } catch {
      lastError = 'JSONの一部が欠けています';
      const partial = salvage(chunk);
      if (partial) return { ok: true, error: '', value: partial };
    }
  }
  const partial = salvage(source);
  if (partial) return { ok: true, error: '', value: partial };
  return { ok: false, error: lastError, value: null };
}

function similarName(a, b) {
  const left = String(a || '').toLowerCase().replace(/[\s　・（）()]/g, '');
  const right = String(b || '').toLowerCase().replace(/[\s　・（）()]/g, '');
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

export function mergeChargerPrices(osmChargers, aiChargers) {
  const used = new Set();
  const merged = (osmChargers || []).map((osm) => {
    let hitIndex = -1;
    const hit = (aiChargers || []).find((ai, index) => {
      if (used.has(index)) return false;
      const close = Number.isFinite(Number(ai.lat)) && Number.isFinite(Number(ai.lon))
        && haversineKm(osm.lat, osm.lon, Number(ai.lat), Number(ai.lon)) < 0.6;
      if (!(close || similarName(osm.name, ai.name))) return false;
      hitIndex = index;
      return true;
    });
    if (!hit) return osm;
    used.add(hitIndex);
    return {
      ...osm,
      address: osm.address || hit.address,
      operatorClass: hit.operatorClass && hit.operatorClass !== 'unknown' ? hit.operatorClass : osm.operatorClass,
      operatorName: hit.operatorName || osm.operatorName,
      powerKw: osm.powerKw || hit.powerKw || null,
      ai: hit.ai || osm.ai
    };
  });
  (aiChargers || []).forEach((ai, index) => {
    if (!used.has(index)) merged.push(ai);
  });
  return merged;
}
