/**
 * Build data/chargers-jp.json from the Geofabrik Japan extracts and, when
 * OCM_API_KEY is set, Open Charge Map (countrycode=JP, opendata=true).
 *
 * AC-only stations go to data/chargers-jp-ac.json. The app loads the main file.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGIONS = ['hokkaido', 'tohoku', 'kanto', 'chubu', 'kansai', 'chugoku', 'shikoku', 'kyushu'];
const KYUSHU = { south: 30.0, north: 34.05, west: 129.0, east: 132.2 };

const DC_SOCKETS = [
  ['socket:chademo', 'CHAdeMO'],
  ['socket:ccs', 'CCS'],
  ['socket:type2_combo', 'CCS'],
  ['socket:tesla_supercharger', 'NACS'],
  ['socket:nacs', 'NACS']
];
const AC_SOCKETS = [
  ['socket:type2', 'Type2'],
  ['socket:type1', 'Type1'],
  ['socket:j1772', 'Type1'],
  ['socket:schuko', 'Schuko']
];

function socketOn(tags, key) {
  const value = tags?.[key];
  if (value == null || value === '' || value === 'no' || value === '0') return false;
  return true;
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function pointOf(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Point') return { lon: geometry.coordinates[0], lat: geometry.coordinates[1] };
  const coords = geometry.type === 'LineString'
    ? geometry.coordinates
    : geometry.type === 'Polygon'
      ? geometry.coordinates?.[0]
      : null;
  if (!coords?.length) return null;
  const lon = coords.reduce((sum, c) => sum + c[0], 0) / coords.length;
  const lat = coords.reduce((sum, c) => sum + c[1], 0) / coords.length;
  return { lat, lon };
}

function connectorsOf(tags) {
  const dc = [];
  const ac = [];
  for (const [key, label] of DC_SOCKETS) if (socketOn(tags, key)) dc.push(label);
  for (const [key, label] of AC_SOCKETS) if (socketOn(tags, key)) ac.push(label);
  return { dc: [...new Set(dc)], ac: [...new Set(ac)] };
}

function maxKwOf(tags) {
  const keys = [
    'socket:chademo:output',
    'socket:ccs:output',
    'socket:type2_combo:output',
    'socket:nacs:output',
    'socket:type2:output',
    'socket:type1:output'
  ];
  let max = null;
  for (const key of keys) {
    const n = finite(tags[key]);
    if (n > 0) max = max == null ? n : Math.max(max, n);
  }
  return max;
}

function countOf(tags, dcLabels) {
  const values = [];
  if (dcLabels.includes('CHAdeMO')) values.push(finite(tags['socket:chademo']));
  if (dcLabels.includes('CCS')) values.push(finite(tags['socket:ccs']), finite(tags['socket:type2_combo']));
  values.push(finite(tags.capacity));
  const nums = values.filter((n) => n > 0 && n < 40);
  if (!nums.length) return null;
  return Math.max(...nums);
}

function addressOf(tags) {
  return [tags['addr:state'], tags['addr:city'], tags['addr:suburb'], tags['addr:street'], tags['addr:housenumber']]
    .filter(Boolean)
    .join('');
}

function nameOf(tags, lat, lon) {
  return String(tags.name || tags['name:ja'] || tags.operator || tags.brand || tags.network || `充電スポット（${lat.toFixed(3)}, ${lon.toFixed(3)}）`).slice(0, 80);
}

function isoDate(value) {
  if (!value) return '';
  if (typeof value === 'number') return new Date(value * 1000).toISOString().slice(0, 10);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export function recordFromTags({ tags, lat, lon, source, sourceId, updated }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < 20 || lat > 50 || lon < 122 || lon > 154) return null;
  const { dc, ac } = connectorsOf(tags || {});
  const maxKw = maxKwOf(tags || {});
  const acOnly = dc.length === 0 && ac.length > 0 && !(maxKw >= 20);
  const connectors = dc.length ? dc : ac;
  const record = {
    name: nameOf(tags || {}, lat, lon),
    lat: Math.round(lat * 1e5) / 1e5,
    lon: Math.round(lon * 1e5) / 1e5,
    address: addressOf(tags || {}).slice(0, 120),
    operator: String((tags || {}).operator || (tags || {}).brand || (tags || {}).network || '').slice(0, 80),
    connectors,
    maxKw,
    count: countOf(tags || {}, dc),
    hours: String((tags || {}).opening_hours || '').slice(0, 160),
    source,
    sourceId: String(sourceId || ''),
    updated: isoDate(updated),
    dc: dc.length > 0 || maxKw >= 20,
    acOnly
  };
  return record;
}

export function normalizeOsmFeature(feature) {
  const point = pointOf(feature.geometry);
  if (!point) return null;
  return recordFromTags({
    tags: feature.properties || {},
    lat: point.lat,
    lon: point.lon,
    source: 'osm',
    sourceId: feature.id || '',
    updated: feature.properties?.['@timestamp']
  });
}

export function normalizeOcmPoi(poi) {
  const addr = poi.AddressInfo || {};
  const conns = poi.Connections || [];
  const tags = {};
  for (const conn of conns) {
    const title = `${conn.ConnectionType?.Title || ''} ${conn.CurrentType?.Title || ''}`.toLowerCase();
    const kw = conn.PowerKW;
    if (title.includes('chademo')) {
      tags['socket:chademo'] = conn.Quantity || 1;
      if (kw) tags['socket:chademo:output'] = kw;
    } else if (title.includes('ccs') || title.includes('combo')) {
      tags['socket:ccs'] = conn.Quantity || 1;
      if (kw) tags['socket:ccs:output'] = kw;
    } else if (title.includes('type 2') || title.includes('type2')) {
      tags['socket:type2'] = conn.Quantity || 1;
      if (kw) tags['socket:type2:output'] = kw;
    } else if (kw >= 20) {
      tags['socket:chademo'] = conn.Quantity || 1;
      tags['socket:chademo:output'] = kw;
    }
  }
  tags.name = addr.Title || poi.OperatorInfo?.Title || '';
  tags.operator = poi.OperatorInfo?.Title || '';
  tags['addr:city'] = addr.Town || addr.StateOrProvince || '';
  tags['addr:street'] = addr.AddressLine1 || '';
  tags.opening_hours = '';
  return recordFromTags({
    tags,
    lat: Number(addr.Latitude),
    lon: Number(addr.Longitude),
    source: 'ocm',
    sourceId: poi.ID != null ? `ocm/${poi.ID}` : '',
    updated: poi.DateLastStatusUpdate || poi.DateLastVerified || ''
  });
}

function norm(text) {
  return String(text || '').toLowerCase().replace(/[\s　・（）()]/g, '');
}

function samePlace(a, b) {
  if (haversineKm(a.lat, a.lon, b.lat, b.lon) > 0.05) return false;
  const an = norm(a.name);
  const bn = norm(b.name);
  const ao = norm(a.operator);
  const bo = norm(b.operator);
  if (an && bn && (an === bn || an.includes(bn) || bn.includes(an))) return true;
  if (ao && bo && ao === bo) return true;
  if ((!an || an.startsWith('充電スポット')) && (!bn || bn.startsWith('充電スポット'))) return true;
  return false;
}

function quality(row) {
  return (row.dc ? 4 : 0) + (row.maxKw ? 2 : 0) + (row.operator ? 1 : 0) + (row.name && !row.name.startsWith('充電スポット') ? 2 : 0) + (row.source === 'ocm' ? 1 : 0);
}

export function dedupeChargers(rows) {
  const kept = [];
  for (const row of rows) {
    const hit = kept.find((other) => samePlace(other, row));
    if (!hit) {
      kept.push(row);
      continue;
    }
    if (quality(row) > quality(hit)) {
      const index = kept.indexOf(hit);
      kept[index] = {
        ...row,
        connectors: [...new Set([...(row.connectors || []), ...(hit.connectors || [])])],
        maxKw: row.maxKw || hit.maxKw,
        hours: row.hours || hit.hours,
        operator: row.operator || hit.operator,
        address: row.address || hit.address,
        dc: row.dc || hit.dc
      };
    }
  }
  return kept;
}

function readGeojsonl(path) {
  const text = readFileSync(path, 'utf8');
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\u001e/, '').trim();
    if (!line) continue;
    out.push(normalizeOsmFeature(JSON.parse(line)));
  }
  return out.filter(Boolean);
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
}

function buildOsmGeojson(work) {
  mkdirSync(work, { recursive: true });
  const parts = [];
  for (const region of REGIONS) {
    const pbf = join(work, `${region}.osm.pbf`);
    const filtered = join(work, `${region}-chargers.osm.pbf`);
    const seq = join(work, `${region}.geojsonl`);
    console.log(`download ${region}`);
    run('curl', ['-fsSL', '-o', pbf, `https://download.geofabrik.de/asia/japan/${region}-latest.osm.pbf`]);
    run('osmium', ['tags-filter', pbf, 'n/amenity=charging_station', 'w/amenity=charging_station', 'r/amenity=charging_station', '-o', filtered, '--overwrite']);
    run('osmium', ['export', filtered, '-f', 'geojsonseq', '-o', seq, '--overwrite', '-u', 'type_id', '-a', 'version,timestamp']);
    parts.push(seq);
    rmSync(pbf, { force: true });
  }
  return parts.flatMap(readGeojsonl);
}

async function fetchOcm(apiKey) {
  if (!apiKey) {
    console.log('OCM_API_KEY が無いため Open Charge Map はスキップしました。');
    return { rows: [], skipped: true };
  }
  const rows = [];
  for (let page = 0; page < 40; page += 1) {
    const url = `https://api.openchargemap.io/v3/poi/?output=json&countrycode=JP&opendata=true&maxresults=500&compact=true&verbose=false&camelcase=true&offset=${page * 500}`;
    const res = await fetch(url, { headers: { 'X-API-Key': apiKey, Accept: 'application/json' } });
    if (!res.ok) {
      console.log(`Open Charge Map HTTP ${res.status}。ここまでで ${rows.length} 件です。`);
      break;
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch.map(normalizeOcmPoi).filter(Boolean));
    if (batch.length < 500) break;
  }
  return { rows, skipped: false };
}

function inKyushu(row) {
  return row.lat >= KYUSHU.south && row.lat <= KYUSHU.north && row.lon >= KYUSHU.west && row.lon <= KYUSHU.east;
}

function pack(rows, meta) {
  return {
    version: 1,
    updated: new Date().toISOString().slice(0, 10),
    counts: {
      total: rows.length,
      dc: rows.filter((row) => row.dc).length,
      kyushu: rows.filter(inKyushu).length
    },
    attribution: meta,
    chargers: rows.map(({ acOnly, ...row }) => row)
  };
}

async function main() {
  const arg = process.argv.indexOf('--geojsonl');
  const geojsonl = arg >= 0 ? process.argv[arg + 1] : '';
  const osmRows = geojsonl ? readGeojsonl(geojsonl) : buildOsmGeojson(mkdtempSync(join(tmpdir(), 'chargers-')));
  const ocm = await fetchOcm(process.env.OCM_API_KEY || '');
  const merged = dedupeChargers([...osmRows, ...ocm.rows].filter((row) => !row.acOnly));
  const ac = dedupeChargers([...osmRows, ...ocm.rows].filter((row) => row.acOnly));
  merged.sort((a, b) => b.lat - a.lat || a.lon - b.lon);
  const attribution = [
    {
      name: 'OpenStreetMap',
      license: 'ODbL',
      url: 'https://www.openstreetmap.org/copyright',
      included: true,
      note: 'Geofabrik の日本リージョン抽出（amenity=charging_station）'
    },
    {
      name: 'Open Charge Map',
      license: 'Open Charge Map のライセンス（各POIのライセンスに従う）',
      url: 'https://openchargemap.org/',
      included: !ocm.skipped && ocm.rows.length > 0,
      note: ocm.skipped ? 'OCM_API_KEY が無いため未収録' : `${ocm.rows.length}件を照合`
    }
  ];
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const mainFile = pack(merged, attribution);
  writeFileSync(join(ROOT, 'data', 'chargers-jp.json'), JSON.stringify(mainFile));
  writeFileSync(join(ROOT, 'data', 'chargers-jp-ac.json'), JSON.stringify(pack(ac, attribution)));
  console.log(JSON.stringify({ main: mainFile.counts, ac: ac.length, ocmSkipped: ocm.skipped }, null, 2));
}

const invoked = process.argv[1] && process.argv[1].endsWith('build-chargers.mjs');
if (invoked) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
