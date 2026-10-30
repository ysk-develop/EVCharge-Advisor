/**
 * Re-read spot pages that were stored without a price, using the current parser.
 * One request at a time, with the same crawl delay as the main fetch.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSpotFacts } from '../js/app-pricing.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'chargers-kyushu-spots.json');
const DELAY_MS = 1100;
const UA = 'EVCharge-Advisor/14 (bundled fare cache; +https://github.com/ysk-develop/EVCharge-Advisor)';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  let bestGap = Infinity;
  for (const row of brackets) {
    const gap = Math.abs(Number(row[1]) - target);
    if (gap < bestGap) {
      best = row;
      bestGap = gap;
    }
  }
  const cleaned = text.replace(/\[\s*\d+\s*kW[^\]]*\][^[]*/g, ' ').replace(/\s+/g, ' ').trim();
  return `${cleaned}\n${best[0].trim()}`;
}

async function main() {
  const data = JSON.parse(readFileSync(OUT, 'utf8'));
  const pending = data.spots.filter((spot) => !(spot.appPrices || []).length);
  console.log(`repair ${pending.length} of ${data.spots.length}`);
  for (const spot of pending) {
    await sleep(DELAY_MS);
    const res = await fetch(spot.sourceUrl, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    if (!res.ok) {
      console.log(`fail ${spot.name} ${res.status}`);
      continue;
    }
    const html = await res.text();
    const notes = field(html, /_pricing-notes-area_[^"]*">([\s\S]*?)<\/pre>/);
    const facts = extractSpotFacts(notesForKw(notes, spot.powerKw), spot.sourceUrl);
    spot.empSpot = facts.empSpot;
    spot.authSystems = facts.authSystems;
    spot.usableApps = facts.usableApps;
    spot.appPrices = facts.appPrices;
    console.log(`${spot.name} prices ${facts.appPrices.length} emp ${facts.empSpot}`);
  }
  data.updated = new Date().toISOString().slice(0, 10);
  writeFileSync(OUT, `${JSON.stringify(data)}\n`);
  const priced = data.spots.filter((spot) => (spot.appPrices || []).length).length;
  console.log(`priced ${priced}/${data.spots.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
