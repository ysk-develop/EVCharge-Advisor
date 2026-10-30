/**
 * Polite fetch of EVsmart spot pages along the Fukuoka–Nobeoka and
 * Fukuoka–Itoshima corridors. robots.txt allows /spot/ with Crawl-delay: 1
 * and disallows /api/ and /mapSearch/. This script only requests /spot/ pages.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSpotFacts } from '../js/app-pricing.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'chargers-kyushu-spots.json');
const ORIGIN = 'https://www.evsmart.net';
const DELAY_MS = 1100;
const UA = 'EVCharge-Advisor/14 (bundled fare cache; +https://github.com/ysk-develop/EVCharge-Advisor)';
const TODAY = new Date().toISOString().slice(0, 10);

const CITIES = [
  ['糸島市', '/spot/fukuoka/l402303'],
  ['福岡市', '/spot/fukuoka/l401307'],
  ['太宰府市', '/spot/fukuoka/l402214'],
  ['筑紫野市', '/spot/fukuoka/l402176'],
  ['朝倉市', '/spot/fukuoka/l402281'],
  ['うきは市', '/spot/fukuoka/l402257'],
  ['小郡市', '/spot/fukuoka/l402168'],
  ['久留米市', '/spot/fukuoka/l402036'],
  ['春日市', '/spot/fukuoka/l402184'],
  ['大野城市', '/spot/fukuoka/l402192'],
  ['古賀市', '/spot/fukuoka/l402231'],
  ['那珂川市', '/spot/fukuoka/l402311'],
  ['鳥栖市', '/spot/saga/l412031'],
  ['基山町', '/spot/saga/l413411'],
  ['日田市', '/spot/oita/l442046'],
  ['九重町', '/spot/oita/l444618'],
  ['玖珠町', '/spot/oita/l444626'],
  ['由布市', '/spot/oita/l442135'],
  ['別府市', '/spot/oita/l442020'],
  ['大分市', '/spot/oita/l442011'],
  ['日出町', '/spot/oita/l443417'],
  ['臼杵市', '/spot/oita/l442062'],
  ['津久見市', '/spot/oita/l442071'],
  ['佐伯市', '/spot/oita/l442054'],
  ['延岡市', '/spot/miyazaki/l452033'],
  ['門川町', '/spot/miyazaki/l454214'],
  ['日向市', '/spot/miyazaki/l452068'],
  ['行橋市', '/spot/fukuoka/l402133'],
  ['苅田町', '/spot/fukuoka/l406210'],
  ['みやこ町', '/spot/fukuoka/l406252'],
  ['築上町', '/spot/fukuoka/l406473'],
  ['上毛町', '/spot/fukuoka/l406465'],
  ['豊前市', '/spot/fukuoka/l402141'],
  ['中津市', '/spot/oita/l442038'],
  ['宇佐市', '/spot/oita/l442119']
];

const EXTRA = ['/spot/fukuoka/l401307/q401315/v35709'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function get(path) {
  const url = path.startsWith('http') ? path : `${ORIGIN}${path}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

function rapidPaths(html) {
  const found = [];
  const parts = html.split('_spot-box_');
  for (const part of parts.slice(1)) {
    const href = part.match(/href="(\/spot\/[^"]+\/v\d+)"/);
    if (!href || href[1].includes('comments')) continue;
    const text = part.replace(/<[^>]+>/g, ' ').slice(0, 900);
    const kws = [...text.matchAll(/(\d+(?:\.\d+)?)\s*kW/g)].map((row) => Number(row[1]));
    const max = kws.length ? Math.max(...kws) : 0;
    if (max >= 40 && /急速/.test(text)) found.push(href[1]);
  }
  return [...new Set(found)];
}

function field(html, pattern) {
  const match = html.match(pattern);
  return match ? match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function plugKw(html) {
  const plugs = [];
  const re = /_plug-item-name_[\w-]*">([^<]*急速[^<]*)<[\s\S]{0,240}?最大出力:\s*(?:<!-- -->)?(\d+(?:\.\d+)?)/g;
  for (const row of html.matchAll(re)) {
    plugs.push({ name: row[1].replace(/\s+/g, ''), kw: Number(row[2]) });
  }
  return plugs;
}

function hoursOf(html) {
  const block = html.match(/利用可能時間<\/th><td>([\s\S]{0,500}?)<\/td>/);
  if (!block) return '';
  const days = [...block[1].matchAll(/<span>([^<]+)<\/span><span>([^<]+)<\/span>/g)];
  const weekday = days.find((row) => row[1].includes('平日'));
  if (!weekday) return '';
  return weekday[2].includes('24') ? '24時間' : `平日 ${weekday[2]}`;
}

function notesForKw(notes, kw) {
  const text = String(notes || '').replace(/\s+/g, ' ').trim();
  const brackets = [...text.matchAll(/\[\s*(\d+)\s*kW[^\]]*\][^[]*/g)].filter((row) => /円/.test(row[0]));
  if (!brackets.length || kw == null) return text;
  const target = Math.min(kw, 90);
  let best = brackets[0];
  let bestGap = Infinity;
  for (const row of brackets) {
    const gap = Math.abs(Number(row[1]) - target);
    if (gap < bestGap) {
      best = row;
      bestGap = gap;
    }
  }
  const rest = text.replace(/\[\s*\d+\s*kW[^\]]*\][^[]*/g, ' ').replace(/\s+/g, ' ').trim();
  return `${rest}\n${best[0].trim()}`;
}

function parseSpot(html, sourceUrl) {
  const name = field(html, /<h1[^>]*>([^<]+)<\/h1>/);
  const address = field(html, /_station-postal-text_[^"]*">([^<]+)</);
  const center = html.match(/staticmap\?center=([\d.]+)%2C([\d.]+)/);
  const notes = field(html, /_pricing-notes-area_[^"]*">([\s\S]*?)<\/pre>/).replace(/<br\s*\/?>/gi, '\n');
  const category = field(html, />分類<\/th><td>([^<]+)</);
  const plugs = plugKw(html);
  const rapid = plugs.filter((row) => /CHAdeMO|急速/.test(row.name) && row.kw >= 40);
  const pool = rapid.length ? rapid : plugs.filter((row) => row.kw >= 40);
  const under90 = pool.filter((row) => row.kw <= 90);
  const chosen = (under90.length ? under90 : pool).sort((a, b) => b.kw - a.kw)[0];
  const powerKw = chosen?.kw ?? null;
  const facts = extractSpotFacts(notesForKw(notes, powerKw), sourceUrl);
  if (!name || !center) return null;
  const highway = /高速/.test(category) || /SA|PA|サービスエリア|パーキングエリア/.test(name);
  return {
    id: sourceUrl.replace(/\/$/, '').split('/').pop(),
    name,
    address,
    lat: Number(center[1]),
    lon: Number(center[2]),
    powerKw,
    connector: /CHAdeMO/.test(html.slice(html.indexOf('<h1'), html.indexOf('<h1') + 2500)) ? 'CHAdeMO' : (chosen ? '急速' : ''),
    hours: hoursOf(html),
    locationType: highway ? 'highway' : 'general',
    empSpot: facts.empSpot,
    authSystems: facts.authSystems,
    usableApps: facts.usableApps,
    appPrices: facts.appPrices,
    sourceUrl,
    fetchedAt: TODAY
  };
}

async function main() {
  const only = process.argv.slice(2);
  const cities = only.length ? CITIES.filter((row) => only.includes(row[0])) : CITIES;
  const paths = [];
  for (const [city, path] of cities) {
    await sleep(DELAY_MS);
    process.stdout.write(`list ${city} `);
    try {
      const html = await get(path);
      const links = rapidPaths(html);
      console.log(links.length);
      for (const link of links) paths.push(link);
    } catch (err) {
      console.log(`skip ${err.message}`);
    }
  }
  for (const extra of EXTRA) paths.push(extra);
  const unique = [...new Set(paths.map((path) => path.replace(/\/$/, '')))];
  console.log(`detail pages ${unique.length}`);
  const spots = [];
  for (const path of unique) {
    await sleep(DELAY_MS);
    const sourceUrl = `${ORIGIN}${path}`;
    try {
      const html = await get(path);
      const spot = parseSpot(html, sourceUrl);
      if (!spot || !(spot.powerKw >= 40)) {
        console.log(`skip ${path} (not rapid)`);
        continue;
      }
      spots.push(spot);
      console.log(`${spots.length} ${spot.name} ${spot.powerKw}kW prices ${spot.appPrices.length}`);
    } catch (err) {
      console.log(`fail ${path} ${err.message}`);
    }
  }
  const byId = new Map();
  if (only.length) {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    for (const spot of prev.spots || []) byId.set(spot.id, spot);
  }
  for (const spot of spots) byId.set(spot.id, spot);
  const list = [...byId.values()];
  const lats = list.map((row) => row.lat);
  const lons = list.map((row) => row.lon);
  const payload = {
    updated: TODAY,
    source: 'EVsmart spot pages',
    robots: 'https://www.evsmart.net/robots.txt allows /spot/ (Crawl-delay: 1) and disallows /api/ and /mapSearch/. This file only uses /spot/ pages, one request at a time.',
    coverage: {
      note: '福岡↔延岡（九州道・大分道・東九州道）と福岡市↔糸島沿いの出力40kW以上',
      municipalities: [...new Set([...(only.length ? JSON.parse(readFileSync(OUT, 'utf8')).coverage?.municipalities || [] : []), ...cities.map((row) => row[0])])],
      south: lats.length ? Math.min(...lats) : null,
      north: lats.length ? Math.max(...lats) : null,
      west: lons.length ? Math.min(...lons) : null,
      east: lons.length ? Math.max(...lons) : null
    },
    count: list.length,
    spots: list
  };
  writeFileSync(OUT, `${JSON.stringify(payload)}\n`);
  console.log(`wrote ${list.length} spots`);
  if (!list.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
