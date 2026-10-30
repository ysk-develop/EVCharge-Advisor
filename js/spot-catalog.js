/**
 * Pre-fetched Kyushu rapid chargers (EVsmart spot pages).
 * Areas inside this file's coverage skip the live search.
 */
import { haversineKm } from './geo.js';

let pending = null;

export function resetSpotCatalog() {
  pending = null;
}

export async function loadSpotCatalog() {
  if (!pending) {
    pending = fetch(new URL('../data/chargers-kyushu-spots.json', import.meta.url))
      .then((res) => {
        if (!res.ok) throw new Error(`充電スポットを読めません（HTTP ${res.status}）`);
        return res.json();
      })
      .then(indexSpots)
      .catch((err) => {
        pending = null;
        throw err;
      });
  }
  return pending;
}

export function indexSpots(data) {
  const spots = (data?.spots || []).map(toCharger).filter((row) => row.lat != null && row.lon != null);
  const coverage = data?.coverage || {};
  const pad = 0.25;
  return {
    updated: data?.updated || '',
    count: spots.length,
    coverage,
    spots,
    covers(lat, lon) {
      if (coverage.south == null) return false;
      const inBox = lat >= coverage.south - pad && lat <= coverage.north + pad
        && lon >= coverage.west - pad && lon <= coverage.east + pad;
      if (!inBox) return false;
      return spots.some((spot) => haversineKm(lat, lon, spot.lat, spot.lon) <= 18);
    },
    near(lat, lon, km = 18) {
      return spots
        .map((spot) => ({ ...spot, distanceKm: haversineKm(lat, lon, spot.lat, spot.lon) }))
        .filter((spot) => spot.distanceKm <= km)
        .sort((a, b) => a.distanceKm - b.distanceKm);
    }
  };
}

export function toCharger(row) {
  return {
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    address: row.address || '',
    powerKw: row.powerKw ?? null,
    connector: row.connector || '',
    hours: row.hours || '',
    hoursConflict: '',
    locationType: row.locationType || 'general',
    empSpot: Boolean(row.empSpot),
    authSystems: row.authSystems || [],
    usableApps: row.usableApps || [],
    appPrices: row.appPrices || [],
    operatorClass: /日産|トヨタ|三菱|ホンダ|マツダ|スバル|ディーラー/.test(row.name || '')
      ? 'emp_partner'
      : (row.empSpot ? 'emp_operated' : 'other'),
    operatorName: (row.authSystems || []).join('、'),
    routeId: '',
    preferred: true,
    fallback: false,
    bundled: true,
    sourceUrl: row.sourceUrl || '',
    fetchedAt: row.fetchedAt || '',
    ai: {
      priceKnown: false,
      priceType: 'unknown',
      unitPrice: null,
      sources: row.sourceUrl ? [row.sourceUrl] : [],
      checkedAt: row.fetchedAt || ''
    }
  };
}

export function spotsForAreas(catalog, areas, radiusKm = 18) {
  const seen = new Set();
  const out = [];
  for (const area of areas || []) {
    const rows = catalog.near(area.lat, area.lon, radiusKm).slice(0, 8);
    for (const row of rows) {
      const id = `${row.name}|${row.lat}|${row.lon}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(row);
    }
  }
  return out;
}
