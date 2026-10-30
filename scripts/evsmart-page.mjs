/**
 * Read EVsmart /spot/ HTML. robots.txt allows /spot/ (Crawl-delay: 1)
 * and disallows /api/ and /mapSearch/. Callers must wait at least 1 second.
 */
import { extractSpotFacts } from '../js/app-pricing.js';

export const EVSMART_ORIGIN = 'https://www.evsmart.net';
export const EVSMART_UA = 'EVCharge-Advisor/16 (spot-crawl; +https://github.com/ysk-develop/EVCharge-Advisor)';

export function citiesFromPref(html, pref) {
  const rows = [...String(html).matchAll(new RegExp(`href="(/spot/${pref}/l\\d+)"[^>]*>([^<]+)`, 'g'))];
  const seen = new Set();
  const cities = [];
  for (const row of rows) {
    if (seen.has(row[1])) continue;
    seen.add(row[1]);
    const name = row[2].replace(/\s+/g, '').trim();
    if (!name || name.length > 30) continue;
    cities.push({ path: row[1], name });
  }
  return cities;
}

export function rapidPaths(html) {
  const found = [];
  for (const part of String(html).split('_spot-box_').slice(1)) {
    const href = part.match(/href="(\/spot\/[^"]+\/v\d+)"/);
    if (!href || href[1].includes('comments')) continue;
    const text = part.replace(/<[^>]+>/g, ' ').slice(0, 900);
    const kws = [...text.matchAll(/(\d+(?:\.\d+)?)\s*kW/g)].map((row) => Number(row[1]));
    const max = kws.length ? Math.max(...kws) : 0;
    if (max >= 40 && /急速/.test(text)) found.push(href[1].replace(/\/$/, ''));
  }
  return [...new Set(found)];
}

function field(html, pattern) {
  const match = html.match(pattern);
  return match ? match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function notesForKw(notes, kw) {
  const text = String(notes || '').replace(/\s+/g, ' ').trim();
  const brackets = [...text.matchAll(/\[\s*(\d+)\s*kW[^\]]*\][^[]*/g)].filter((row) => /円/.test(row[0]));
  if (!brackets.length || kw == null) return text;
  const target = Math.min(kw, 90);
  let best = brackets[0];
  let gap = Infinity;
  for (const row of brackets) {
    const next = Math.abs(Number(row[1]) - target);
    if (next < gap) {
      best = row;
      gap = next;
    }
  }
  const rest = text.replace(/\[\s*\d+\s*kW[^\]]*\][^[]*/g, ' ').replace(/\s+/g, ' ').trim();
  return `${rest}\n${best[0].trim()}`;
}

export function parseSpotHtml(html, sourceUrl, fetchedAt) {
  const name = field(html, /<h1[^>]*>([^<]+)<\/h1>/);
  const address = field(html, /_station-postal-text_[^"]*">([^<]+)</);
  const center = html.match(/staticmap\?center=([\d.]+)%2C([\d.]+)/);
  const notes = field(html, /_pricing-notes-area_[^"]*">([\s\S]*?)<\/pre>/);
  const category = field(html, />分類<\/th><td>([^<]+)</);
  const plugs = [];
  const plugRe = /_plug-item-name_[\w-]*">([^<]*急速[^<]*)<[\s\S]{0,240}?最大出力:\s*(?:<!-- -->)?(\d+(?:\.\d+)?)/g;
  for (const row of html.matchAll(plugRe)) plugs.push({ name: row[1], kw: Number(row[2]) });
  const rapid = plugs.filter((row) => row.kw >= 40);
  const under90 = rapid.filter((row) => row.kw <= 90);
  const chosen = (under90.length ? under90 : rapid).sort((a, b) => b.kw - a.kw)[0];
  const powerKw = chosen?.kw ?? null;
  const facts = extractSpotFacts(notesForKw(notes, powerKw), sourceUrl);
  if (!name || !center || !(powerKw >= 40)) return null;
  const head = html.slice(html.indexOf('<h1'), html.indexOf('<h1') + 2500);
  const hoursBlock = html.match(/利用可能時間<\/th><td>([\s\S]{0,500}?)<\/td>/);
  let hours = '';
  if (hoursBlock) {
    const days = [...hoursBlock[1].matchAll(/<span>([^<]+)<\/span><span>([^<]+)<\/span>/g)];
    const weekday = days.find((row) => row[1].includes('平日'));
    if (weekday) hours = weekday[2].includes('24') ? '24時間' : `平日 ${weekday[2]}`;
  }
  const highway = /高速/.test(category) || /SA|PA|サービスエリア|パーキングエリア/.test(name);
  return {
    id: sourceUrl.replace(/\/$/, '').split('/').pop(),
    name,
    address,
    lat: Number(center[1]),
    lon: Number(center[2]),
    powerKw,
    connector: /CHAdeMO/.test(head) ? 'CHAdeMO' : '急速',
    hours,
    locationType: highway ? 'highway' : 'general',
    empSpot: facts.empSpot,
    authSystems: facts.authSystems,
    usableApps: facts.usableApps,
    appPrices: facts.appPrices,
    sourceUrl,
    fetchedAt
  };
}

export function spotIdFromPath(path) {
  const match = String(path).match(/\/(v\d+)\/?$/);
  return match ? match[1] : '';
}

export function cityPathFromUrl(url) {
  const match = String(url).match(/\/spot\/[a-z]+\/l\d+/);
  return match ? match[0] : '';
}
