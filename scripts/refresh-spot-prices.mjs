/**
 * Re-read cached EVsmart /spot/ pages and fill direct card/QR prices.
 * robots.txt allows /spot/ with Crawl-delay: 1. A failed fetch keeps the old record.
 */
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVSMART_UA, parseSpotHtml } from './evsmart-page.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPOT_DIR = join(ROOT, 'data', 'spots');
const DELAY_MS = 1100;
const TODAY = new Date().toISOString().slice(0, 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasPrice(spot) {
  return (spot.appPrices || []).some((row) => row.priceType === 'free' || Number(row.unitPrice) > 0);
}

function writeJson(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  renameSync(tmp, path);
}

async function getHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': EVSMART_UA, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

const files = readdirSync(SPOT_DIR).filter((name) => name.endsWith('.json') && name !== 'manifest.json' && name !== 'state.json');
const summary = { checked: 0, gained: 0, kept: 0, failed: 0, direct: 0 };

for (const name of files) {
  const path = join(SPOT_DIR, name);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const spots = doc.spots || [];
  for (let i = 0; i < spots.length; i += 1) {
    const spot = spots[i];
    if (!spot.sourceUrl || !/\/spot\//.test(spot.sourceUrl)) continue;
    summary.checked += 1;
    const before = hasPrice(spot);
    try {
      const html = await getHtml(spot.sourceUrl);
      const parsed = parseSpotHtml(html, spot.sourceUrl, TODAY);
      if (!parsed) {
        summary.kept += 1;
      } else {
        spot.empSpot = parsed.empSpot;
        spot.directPay = parsed.directPay;
        spot.sessionMaxMin = parsed.sessionMaxMin;
        spot.authSystems = parsed.authSystems;
        spot.usableApps = parsed.usableApps;
        spot.appPrices = parsed.appPrices;
        spot.fetchedAt = TODAY;
        if (!before && hasPrice(spot)) summary.gained += 1;
        if (spot.directPay && hasPrice(spot)) summary.direct += 1;
      }
    } catch (error) {
      summary.failed += 1;
      summary.kept += 1;
      console.error('fail', spot.id, error.message);
    }
    if (summary.checked % 25 === 0) {
      writeJson(path, doc);
      console.log(JSON.stringify({ file: name, ...summary }));
    }
    await sleep(DELAY_MS);
  }
  doc.updated = TODAY;
  writeJson(path, doc);
}

const manifestPath = join(SPOT_DIR, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.updated = TODAY;
for (const region of manifest.regions || []) {
  const file = files.find((name) => name === region.file);
  if (!file) continue;
  const doc = JSON.parse(readFileSync(join(SPOT_DIR, file), 'utf8'));
  region.updated = TODAY;
  region.count = (doc.spots || []).length;
}
writeJson(manifestPath, manifest);
console.log('done', JSON.stringify(summary));
