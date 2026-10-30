/**
 * Charger locations come from OpenStreetMap. Gemini search is only asked
 * for prices and tolls, in a compact JSON-in-text answer.
 */

import { haversineKm } from './geo.js';
import { usableAppsFromText } from './app-pricing.js';
import { buildEnergyProfile, chargeWindows } from './route-model.js';

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

function consider(picked, point, minKm) {
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (picked.some((item) => haversineKm(item.lat, item.lon, lat, lon) < minKm)) return;
  picked.push({ lat, lon });
}

function walkShape(shape, spacingKm) {
  const out = [];
  if (!shape?.length) return out;
  let prev = shape[0];
  out.push({ lat: prev[0], lon: prev[1] });
  let walked = 0;
  for (let i = 1; i < shape.length; i += 1) {
    walked += haversineKm(prev[0], prev[1], shape[i][0], shape[i][1]);
    prev = shape[i];
    if (walked >= spacingKm) {
      out.push({ lat: prev[0], lon: prev[1] });
      walked = 0;
    }
  }
  const last = shape[shape.length - 1];
  out.push({ lat: last[0], lon: last[1] });
  return out;
}

export function sampleRoutePoints(routes, spacingKm = 25, vehicle = null) {
  const chargePoints = [];
  const spaced = [];
  for (const route of routes || []) {
    if (vehicle && route?.distanceKm) {
      try {
        const profile = buildEnergyProfile(route, vehicle);
        for (const window of chargeWindows(profile, vehicle)) {
          if (Number.isFinite(window.lat) && Number.isFinite(window.lon)) chargePoints.push(window);
        }
      } catch {
        /* 標高が無くても形だけで地点を取る */
      }
    }
    spaced.push(...walkShape(route?.shape, spacingKm));
  }
  const picked = [];
  for (const point of chargePoints) {
    consider(picked, point, 12);
    if (picked.length >= 8) return picked;
  }
  const room = 8 - picked.length;
  if (room > 0 && spaced.length) {
    const steps = Math.min(room, spaced.length);
    for (let i = 0; i < steps; i += 1) {
      const index = Math.round(i * (spaced.length - 1) / Math.max(steps - 1, 1));
      consider(picked, spaced[index], 12);
      if (picked.length >= 8) break;
    }
  }
  return picked.slice(0, 8);
}

export function buildOverpassQuery(points) {
  const clauses = points.map((point) => (
    `node["amenity"="charging_station"](around:5000,${Number(point.lat).toFixed(5)},${Number(point.lon).toFixed(5)});`
  )).join('');
  return `[out:json][timeout:15];(${clauses});out tags;`;
}

export function describeNetError(err, step) {
  const raw = String(err?.message || err || '').trim();
  if (raw.startsWith(step)) return raw;
  const aborted = Boolean(err?.aborted || err?.gemini?.timeout)
    || err?.name === 'AbortError'
    || /時間内に終わりません|時間内に返りません|The operation was aborted/i.test(raw);
  if (aborted) return `${step}が時間内に終わりませんでした。`;
  if (raw === 'Load failed' || /Load failed|Failed to fetch|NetworkError/i.test(raw)) {
    return `${step}に失敗しました（通信エラー）。`;
  }
  if (!raw) return `${step}に失敗しました。`;
  return `${step}に失敗しました。${raw}`.slice(0, 220);
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
      connector: connectorNote,
      usableApps: usableAppsFromText(`${tags.operator || ''} ${tags.network || ''} ${tags.brand || ''} ${tags.name || ''}`),
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
  return out.slice(0, 24);
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function postOverpass(url, query, timeoutMs) {
  const body = new URLSearchParams();
  body.set('data', query);
  const controller = new AbortController();
  let aborted = false;
  const timer = setTimeout(() => {
    aborted = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', body, signal: controller.signal });
    if (!res.ok) {
      const error = new Error(`HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    const data = await res.json();
    return data.elements || [];
  } catch (err) {
    if (aborted || err?.name === 'AbortError') {
      const error = new Error('aborted');
      error.aborted = true;
      throw error;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function queryMirror(url, batches, deadline) {
  const found = [];
  const attempts = [];
  let failures = 0;
  for (let i = 0; i < batches.length; i += 2) {
    if (Date.now() > deadline - 2500) break;
    const slice = batches.slice(i, i + 2);
    const results = await Promise.all(slice.map(async (batch) => {
      const remain = deadline - Date.now();
      if (remain < 2500) return [];
      try {
        const elements = await postOverpass(url, buildOverpassQuery(batch), Math.min(14000, remain));
        attempts.push(`${new URL(url).host}: ${elements.length}件`);
        return elements;
      } catch (err) {
        failures += 1;
        const raw = err?.aborted ? 'timeout' : (err?.message || 'error');
        attempts.push(`${new URL(url).host}: ${raw}`);
        if ((err?.status === 429 || err?.status === 504) && deadline - Date.now() > 5000) {
          await new Promise((resolve) => setTimeout(resolve, 700));
          try {
            const elements = await postOverpass(url, buildOverpassQuery(batch), Math.min(10000, deadline - Date.now()));
            attempts.push(`${new URL(url).host}: 再試行 ${elements.length}件`);
            return elements;
          } catch (retryErr) {
            attempts.push(`${new URL(url).host}: ${retryErr?.aborted ? 'timeout' : (retryErr?.message || 'retry failed')}`);
          }
        }
        return [];
      }
    }));
    results.forEach((list) => found.push(...list));
    const hung = attempts.some((line) => line.startsWith(new URL(url).host) && line.endsWith('timeout'));
    if (found.length === 0 && (hung || failures >= 2)) break;
  }
  return { found, attempts, failures };
}

export async function fetchOsmChargers(routes, { timeoutMs = 36000, checkedAt = '', vehicle = null } = {}) {
  try {
    const points = sampleRoutePoints(routes, 25, vehicle);
    if (!points.length) {
      return { chargers: [], error: 'ルート座標がありません', raw: '', points, attempts: [] };
    }
    const batches = chunk(points, 2);
    const deadline = Date.now() + timeoutMs;
    const attempts = [];
    let elements = [];
    let sawFailure = false;
    for (const url of MIRRORS) {
      if (Date.now() > deadline - 2500) break;
      const result = await queryMirror(url, batches, deadline);
      attempts.push(...result.attempts);
      if (result.failures) sawFailure = true;
      if (result.found.length) {
        elements = result.found;
        break;
      }
    }
    const chargers = chargersFromOverpass(elements, checkedAt);
    let error = '';
    let raw = '';
    if (!chargers.length && sawFailure) {
      raw = attempts.find((line) => !/:\s+\d+件/.test(line)) || attempts[0] || '';
      const token = raw.includes('Load failed') ? 'Load failed'
        : raw.includes('Failed to fetch') ? 'Failed to fetch'
          : raw.includes('timeout') ? 'aborted'
            : raw;
      error = describeNetError(
        { message: token, aborted: token === 'aborted', name: token === 'aborted' ? 'AbortError' : 'TypeError' },
        '地図の充電器検索'
      );
    }
    return { chargers, error, raw, points, attempts };
  } catch (err) {
    return {
      chargers: [],
      error: describeNetError(err, '地図の充電器検索'),
      raw: String(err?.message || ''),
      points: [],
      attempts: []
    };
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
