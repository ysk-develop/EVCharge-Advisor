/**
 * Chargers bundled with the app. The phone does not call Overpass.
 * OpenStreetMap data is ODbL. Open Charge Map is included only when the
 * build had OCM_API_KEY.
 */
import { haversineKm } from './geo.js';
import { classifyOperator } from './charger-price.js';
import { usableAppsFromText } from './app-pricing.js';

let pending = null;

export function resetChargerCatalog() {
  pending = null;
}

export async function loadChargerCatalog() {
  if (!pending) {
    pending = fetch(new URL('../data/chargers-jp.json', import.meta.url))
      .then((res) => {
        if (!res.ok) throw new Error(`充電器データを読めません（HTTP ${res.status}）`);
        return res.json();
      })
      .then(indexCatalog)
      .catch((err) => {
        pending = null;
        throw err;
      });
  }
  return pending;
}

export function indexCatalog(data) {
  const chargers = (data?.chargers || []).map(toRouteCharger);
  return {
    updated: data?.updated || '',
    counts: data?.counts || { total: chargers.length, dc: 0, kyushu: 0 },
    attribution: data?.attribution || [],
    chargers,
    near(lat, lon, km = 15) {
      return chargers
        .map((charger) => ({ ...charger, distanceKm: haversineKm(lat, lon, charger.lat, charger.lon) }))
        .filter((charger) => charger.distanceKm <= km)
        .sort((a, b) => Number(b.dc) - Number(a.dc) || a.distanceKm - b.distanceKm);
    },
    search(query) {
      const q = String(query || '').trim().toLowerCase();
      if (!q) return [];
      return chargers.filter((charger) => `${charger.name} ${charger.operatorName} ${charger.address}`.toLowerCase().includes(q)).slice(0, 20);
    }
  };
}

export function toRouteCharger(row) {
  const highway = /SA|PA|サービスエリア|パーキングエリア|高速/.test(`${row.name || ''} ${row.operator || ''} ${row.address || ''}`);
  const charger = {
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    address: row.address || '',
    powerKw: row.maxKw > 0 ? row.maxKw : null,
    locationType: highway ? 'highway' : 'unknown',
    operatorName: row.operator || '',
    operatorClass: 'unknown',
    connector: (row.connectors || []).join('・'),
    usableApps: usableAppsFromText(`${row.operator || ''} ${row.name || ''}`),
    hours: row.hours || '',
    hoursConflict: '',
    routeId: '',
    source: row.source || 'osm',
    sourceId: row.sourceId || '',
    dc: Boolean(row.dc),
    ai: {
      priceKnown: false,
      priceType: 'unknown',
      unitPrice: null,
      priceNote: '',
      sources: [],
      hours: row.hours || '',
      hoursConflict: '',
      checkedAt: row.updated || ''
    }
  };
  charger.operatorClass = classifyOperator(charger);
  return charger;
}

function shapePoints(shape, step) {
  if (!shape?.length) return [];
  const out = [];
  for (let i = 0; i < shape.length; i += step) out.push(shape[i]);
  out.push(shape[shape.length - 1]);
  return out;
}

export function chargersAlongRoutes(catalog, routes, maxOffKm = 12) {
  const samples = [];
  for (const route of routes || []) {
    samples.push(...shapePoints(route.shape, 8));
  }
  if (!samples.length) return [];
  const seen = new Set();
  const picked = [];
  for (const charger of catalog.chargers || []) {
    let best = Infinity;
    for (const point of samples) {
      const off = haversineKm(charger.lat, charger.lon, point[0], point[1]);
      if (off < best) best = off;
      if (best <= maxOffKm) break;
    }
    if (best > maxOffKm) continue;
    const key = charger.sourceId || `${charger.lat},${charger.lon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(charger);
  }
  picked.sort((a, b) => Number(b.dc) - Number(a.dc));
  return picked;
}
