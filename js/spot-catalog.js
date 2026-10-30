/**
 * Pre-fetched rapid chargers, split by region.
 * A route loads only the region files its roads overlap.
 */
import { haversineKm } from './geo.js';

let manifestPromise = null;
const regionCache = new Map();

export function resetSpotCatalog() {
  manifestPromise = null;
  regionCache.clear();
}

export function boundsOfRoutes(routes) {
  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  let count = 0;
  const take = (lat, lon) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    count += 1;
  };
  for (const route of routes || []) {
    const shape = route.shape || [];
    for (let i = 0; i < shape.length; i += 6) take(shape[i][0], shape[i][1]);
    const last = shape[shape.length - 1];
    if (last) take(last[0], last[1]);
  }
  if (!count) return null;
  return { south, north, west, east };
}

export function regionsForBounds(regions, bounds) {
  const list = regions || [];
  if (!bounds) return list.filter((region) => region.count > 0);
  const pad = 0.35;
  const box = {
    south: bounds.south - pad,
    north: bounds.north + pad,
    west: bounds.west - pad,
    east: bounds.east + pad
  };
  return list.filter((region) => region.count > 0 && overlaps(region, box));
}

function overlaps(region, box) {
  if (region.south == null || region.west == null) return false;
  return region.south <= box.north && region.north >= box.south
    && region.west <= box.east && region.east >= box.west;
}

async function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(new URL('../data/spots/manifest.json', import.meta.url))
      .then((res) => {
        if (!res.ok) throw new Error(`充電スポットの目録を読めません（HTTP ${res.status}）`);
        return res.json();
      })
      .catch((err) => {
        manifestPromise = null;
        throw err;
      });
  }
  return manifestPromise;
}

async function loadRegion(region) {
  if (regionCache.has(region.id)) return regionCache.get(region.id);
  const pending = fetch(new URL(`../data/spots/${region.file}`, import.meta.url))
    .then((res) => {
      if (!res.ok) throw new Error(`充電スポットを読めません（HTTP ${res.status}）`);
      return res.json();
    })
    .catch((err) => {
      regionCache.delete(region.id);
      throw err;
    });
  regionCache.set(region.id, pending);
  return pending;
}

export async function loadSpotCatalog(bounds) {
  const manifest = await loadManifest();
  const wanted = regionsForBounds(manifest.regions, bounds);
  const files = await Promise.all(wanted.map((region) => loadRegion(region)));
  const spots = files.flatMap((file) => file?.spots || []);
  const updated = wanted.map((region) => region.updated).filter(Boolean).sort().at(-1) || manifest.updated || '';
  return indexSpots({ spots, updated, coverage: coverageOf(spots) });
}

function coverageOf(spots) {
  const lats = spots.map((spot) => Number(spot.lat)).filter(Number.isFinite);
  const lons = spots.map((spot) => Number(spot.lon)).filter(Number.isFinite);
  if (!lats.length) return {};
  return {
    south: Math.min(...lats),
    north: Math.max(...lats),
    west: Math.min(...lons),
    east: Math.max(...lons)
  };
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
