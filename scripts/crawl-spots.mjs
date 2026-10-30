/**
 * Resume an EVsmart /spot/ crawl. Each run lists a few municipalities and
 * fetches a bounded number of rapid-charger pages, then saves the queue.
 * A failed page does not remove the spot already on disk.
 *
 *   SPOT_BATCH     detail pages this run (default 200)
 *   SPOT_DISCOVER  municipality or prefecture pages this run (default 40)
 *   SPOT_REFRESH_DAYS  re-fetch a spot after this many days (default 30)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVSMART_ORIGIN,
  EVSMART_UA,
  citiesFromPref,
  cityPathFromUrl,
  parseSpotHtml,
  rapidPaths,
  spotIdFromPath
} from './evsmart-page.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPOT_DIR = join(ROOT, 'data', 'spots');
const STATE_PATH = join(SPOT_DIR, 'state.json');
const MANIFEST_PATH = join(SPOT_DIR, 'manifest.json');
const LEGACY_PATH = join(ROOT, 'data', 'chargers-kyushu-spots.json');
const DELAY_MS = 1100;
const BATCH = Math.max(1, Number(process.env.SPOT_BATCH || 200));
const DISCOVER = Math.max(0, Number(process.env.SPOT_DISCOVER || 40));
const REFRESH_DAYS = Math.max(1, Number(process.env.SPOT_REFRESH_DAYS || 30));

export const REGIONS = [
  { id: 'kyushu', label: '九州', prefs: ['fukuoka', 'saga', 'nagasaki', 'kumamoto', 'oita', 'miyazaki', 'kagoshima'] },
  { id: 'chugoku', label: '中国', prefs: ['tottori', 'shimane', 'okayama', 'hiroshima', 'yamaguchi'] },
  { id: 'shikoku', label: '四国', prefs: ['tokushima', 'kagawa', 'ehime', 'kochi'] },
  { id: 'kansai', label: '近畿', prefs: ['mie', 'shiga', 'kyoto', 'osaka', 'hyogo', 'nara', 'wakayama'] },
  { id: 'chubu', label: '中部', prefs: ['niigata', 'toyama', 'ishikawa', 'fukui', 'yamanashi', 'nagano', 'gifu', 'shizuoka', 'aichi'] },
  { id: 'kanto', label: '関東', prefs: ['ibaraki', 'tochigi', 'gunma', 'saitama', 'chiba', 'tokyo', 'kanagawa'] },
  { id: 'tohoku', label: '東北', prefs: ['aomori', 'iwate', 'miyagi', 'akita', 'yamagata', 'fukushima'] },
  { id: 'hokkaido', label: '北海道', prefs: ['hokkaido'] },
  { id: 'okinawa', label: '沖縄', prefs: ['okinawa'] }
];

const TODAY = new Date().toISOString().slice(0, 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyState() {
  return {
    version: 1,
    updated: TODAY,
    cursor: { region: 0, pref: 0 },
    cities: {},
    listed: {},
    queue: [],
    fetched: {},
    failures: []
  };
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  renameSync(tmp, path);
}

async function getHtml(path) {
  const url = path.startsWith('http') ? path : `${EVSMART_ORIGIN}${path}`;
  const res = await fetch(url, { headers: { 'User-Agent': EVSMART_UA, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

function regionOfPref(pref) {
  return REGIONS.find((region) => region.prefs.includes(pref)) || REGIONS[0];
}

function loadRegions() {
  const regions = {};
  for (const region of REGIONS) {
    const path = join(SPOT_DIR, `${region.id}.json`);
    regions[region.id] = readJson(path, { updated: '', spots: [] });
    if (!Array.isArray(regions[region.id].spots)) regions[region.id].spots = [];
  }
  return regions;
}

function importLegacy(state, regions) {
  if (!existsSync(LEGACY_PATH)) return false;
  if (regions.kyushu.spots.length) return false;
  const legacy = JSON.parse(readFileSync(LEGACY_PATH, 'utf8'));
  const byId = new Map();
  for (const spot of legacy.spots || []) {
    if (!spot?.id || !(spot.powerKw >= 40)) continue;
    byId.set(spot.id, { ...spot, region: 'kyushu' });
    state.fetched[spot.id] = spot.fetchedAt || TODAY;
    const city = cityPathFromUrl(spot.sourceUrl || '');
    if (city) state.listed[city] = spot.fetchedAt || TODAY;
  }
  regions.kyushu.spots = [...byId.values()];
  regions.kyushu.updated = legacy.updated || TODAY;
  return true;
}

function ageDays(iso) {
  const then = new Date(`${iso}T00:00:00Z`).getTime();
  if (!Number.isFinite(then)) return 9999;
  return (Date.now() - then) / 86400000;
}

function needsDetail(state, id) {
  const at = state.fetched[id];
  if (!at) return true;
  return ageDays(at) >= REFRESH_DAYS;
}

function enqueue(state, item) {
  const id = spotIdFromPath(item.path);
  if (!id || !needsDetail(state, id)) return;
  if (state.queue.some((row) => row.path === item.path)) return;
  state.queue.push(item);
}

async function discoverOne(state) {
  const cursor = state.cursor;
  if (cursor.region >= REGIONS.length) return false;
  const region = REGIONS[cursor.region];
  const pref = region.prefs[cursor.pref];
  if (!pref) {
    cursor.region += 1;
    cursor.pref = 0;
    return discoverOne(state);
  }
  if (!state.cities[pref]) {
    const html = await getHtml(`/spot/${pref}/`);
    state.cities[pref] = citiesFromPref(html, pref);
    console.log(`pref ${pref} cities ${state.cities[pref].length}`);
    return true;
  }
  const next = state.cities[pref].find((city) => !state.listed[city.path] || ageDays(state.listed[city.path]) >= REFRESH_DAYS);
  if (!next) {
    cursor.pref += 1;
    return discoverOne(state);
  }
  const html = await getHtml(next.path);
  const links = rapidPaths(html);
  for (const path of links) {
    enqueue(state, { path, region: region.id, pref, city: next.name, kw: null });
  }
  state.listed[next.path] = TODAY;
  console.log(`list ${next.name} rapid ${links.length} queue ${state.queue.length}`);
  return true;
}

function staleSpots(regions, state, limit) {
  const rows = [];
  for (const region of REGIONS) {
    for (const spot of regions[region.id].spots) {
      if (ageDays(spot.fetchedAt) < REFRESH_DAYS) continue;
      const path = String(spot.sourceUrl || '').replace(EVSMART_ORIGIN, '');
      if (!path.startsWith('/spot/')) continue;
      rows.push({ path, region: region.id, pref: '', city: '', kw: spot.powerKw, refresh: true });
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
}

function upsert(regions, spot) {
  const pref = (spot.sourceUrl.match(/\/spot\/([a-z]+)\//) || [])[1] || '';
  const regionId = regionOfPref(pref).id;
  const list = regions[regionId].spots;
  const index = list.findIndex((row) => row.id === spot.id);
  const next = { ...spot, region: regionId };
  if (index >= 0) list[index] = next;
  else list.push(next);
  regions[regionId].updated = TODAY;
}

function dropQueue(state, path) {
  state.queue = state.queue.filter((row) => row.path !== path);
}

function bbox(spots) {
  if (!spots.length) return null;
  const lats = spots.map((spot) => spot.lat).filter(Number.isFinite);
  const lons = spots.map((spot) => spot.lon).filter(Number.isFinite);
  if (!lats.length) return null;
  return {
    south: Math.min(...lats),
    north: Math.max(...lats),
    west: Math.min(...lons),
    east: Math.max(...lons)
  };
}

function writeOutputs(state, regions) {
  const manifest = {
    updated: TODAY,
    note: 'ルートが重なる地域のファイルだけを読みます。',
    regions: REGIONS.map((region) => {
      const spots = regions[region.id].spots;
      return {
        id: region.id,
        label: region.label,
        file: `${region.id}.json`,
        count: spots.length,
        updated: regions[region.id].updated || '',
        ...(bbox(spots) || {})
      };
    }).filter((region) => region.count > 0)
  };
  for (const region of REGIONS) {
    if (!regions[region.id].spots.length && !existsSync(join(SPOT_DIR, `${region.id}.json`))) continue;
    writeJson(join(SPOT_DIR, `${region.id}.json`), {
      updated: regions[region.id].updated || TODAY,
      region: region.id,
      label: region.label,
      spots: regions[region.id].spots
    });
  }
  writeJson(MANIFEST_PATH, manifest);
  state.updated = TODAY;
  writeJson(STATE_PATH, state);
}

function countSpots(regions) {
  return REGIONS.reduce((sum, region) => sum + regions[region.id].spots.length, 0);
}

async function main() {
  mkdirSync(SPOT_DIR, { recursive: true });
  const state = readJson(STATE_PATH, emptyState());
  state.cursor = state.cursor || { region: 0, pref: 0 };
  state.cities = state.cities || {};
  state.listed = state.listed || {};
  state.queue = state.queue || [];
  state.fetched = state.fetched || {};
  state.failures = state.failures || [];
  const regions = loadRegions();
  const migrated = importLegacy(state, regions);
  const before = countSpots(regions);
  let discovered = 0;
  while (discovered < DISCOVER) {
    const fresh = state.queue.filter((row) => needsDetail(state, spotIdFromPath(row.path))).length;
    if (fresh >= BATCH) break;
    if (discovered > 0) await sleep(DELAY_MS);
    try {
      const progressed = await discoverOne(state);
      if (!progressed) break;
      discovered += 1;
    } catch (err) {
      console.log(`discover failed ${err.message}`);
      state.failures.unshift({ at: TODAY, error: String(err.message).slice(0, 180) });
      break;
    }
  }
  let batch = state.queue.filter((row) => needsDetail(state, spotIdFromPath(row.path))).slice(0, BATCH);
  if (batch.length < BATCH && state.cursor.region >= REGIONS.length) {
    const extra = staleSpots(regions, state, BATCH - batch.length);
    batch = batch.concat(extra);
  }
  console.log(`fetch ${batch.length} (discover pages ${discovered})`);
  for (const item of batch) {
    await sleep(DELAY_MS);
    const id = spotIdFromPath(item.path);
    try {
      const html = await getHtml(item.path);
      const sourceUrl = `${EVSMART_ORIGIN}${item.path}`;
      const spot = parseSpotHtml(html, sourceUrl, TODAY);
      if (spot) {
        upsert(regions, spot);
        console.log(`ok ${spot.name} ${spot.powerKw}kW`);
      } else {
        console.log(`skip ${item.path}`);
      }
      if (id) state.fetched[id] = TODAY;
      dropQueue(state, item.path);
    } catch (err) {
      item.tries = (item.tries || 0) + 1;
      console.log(`fail ${item.path} ${err.message}`);
      if (item.tries >= 3) {
        state.failures.unshift({ path: item.path, at: TODAY, error: String(err.message).slice(0, 180) });
        dropQueue(state, item.path);
      }
    }
  }
  state.failures = state.failures.slice(0, 40);
  writeOutputs(state, regions);
  if (migrated && existsSync(LEGACY_PATH)) unlinkSync(LEGACY_PATH);
  const after = countSpots(regions);
  const listed = Object.keys(state.listed).length;
  const knownCities = Object.values(state.cities).reduce((sum, list) => sum + list.length, 0);
  console.log(`spots ${before} -> ${after} (+${after - before})`);
  console.log(`queue ${state.queue.length} listed ${listed} cities known ${knownCities} cursor ${state.cursor.region}:${state.cursor.pref}`);
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
