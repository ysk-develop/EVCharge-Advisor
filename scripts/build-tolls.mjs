/**
 * Bundle Kyushu junction coordinates with published ordinary-car tolls.
 * Fare amounts are the curated table below (official pages and NEXCO/ドラぷら
 * search results). Junction coordinates refresh from an osmium geojson seq
 * export when OSM_JUNCTIONS is set, otherwise the file already in data/ is kept.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'tolls-kyushu.json');
const TODAY = new Date().toISOString().slice(0, 10);

const PAIRS = [
  {
    from: '太宰府',
    to: '延岡',
    yen: 4710,
    km: 250.1,
    source: 'https://kosoku.jp/route.php?c=%E6%99%AE%E9%80%9A%E8%BB%8A&f=%E5%A4%AA%E5%AE%B0%E5%BA%9C&t=%E5%BB%B6%E5%B2%A1%EF%BC%AA%EF%BC%A3%EF%BC%B7%E3%83%BB%EF%BC%A9%EF%BC%A3',
    note: '普通車の通常料金とETC料金は同じ。延岡南ICと延岡JCT・ICの間は0円なので延岡南出口もこの額。'
  },
  {
    from: '福岡',
    to: '鳥栖',
    yen: 950,
    km: 28.9,
    source: 'https://www.driveplaza.com/dp/SearchQuick?arrivePlaceKana=%E9%B3%A5%E6%A0%96&startPlaceKana=%E7%A6%8F%E5%B2%A1%28%E4%B9%9D%E5%B7%9E%E9%81%93%29',
    note: '福岡（九州道）→鳥栖。普通車の通常料金とETC料金は同じ。'
  },
  {
    from: '福岡',
    to: '延岡',
    yen: 4950,
    km: 269.6,
    source: 'https://kosoku.jp/route.php?c=%E6%99%AE%E9%80%9A%E8%BB%8A&f=%E7%A6%8F%E5%B2%A1%EF%BC%88%E4%B9%9D%E5%B7%9E%E9%81%93%EF%BC%89&t=%E5%BB%B6%E5%B2%A1%E5%8D%97',
    note: '福岡（九州道）→延岡南。普通車の通常料金とETC料金は同じ。鳥栖経由・北九州経由とも4,950円。'
  }
];

function fareKey(name) {
  let text = String(name || '').normalize('NFKC').replace(/\s+/g, '');
  text = text.replace(/インターチェンジ|ジャンクション/g, '');
  text = text.replace(/スマートIC|IC|JCT/g, '');
  text = text.replace(/[（(].*?[)）]/g, '');
  if (text === '延岡南') return '延岡';
  return text;
}

function loadJunctions(path) {
  const raw = readFileSync(path);
  const parts = raw.toString('utf8').split('\u001e');
  const rows = [];
  const seen = new Set();
  for (const part of parts) {
    const line = part.trim();
    if (!line) continue;
    const feature = JSON.parse(line);
    const tags = feature.properties || {};
    const name = tags.name || '';
    if (!name) continue;
    if (/SA|PA|サービス|パーキング|ＳＡ|ＰＡ/.test(name)) continue;
    if (!/IC|ＩＣ|JCT|ＪＣＴ|インター|ジャンク/.test(name)) continue;
    const [lon, lat] = feature.geometry?.coordinates || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = fareKey(name);
    const id = `${key}:${lat.toFixed(3)}:${lon.toFixed(3)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      name,
      key,
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5
    });
  }
  return rows;
}

const junctionPath = process.env.OSM_JUNCTIONS || '/tmp/osm/kyushu-ic.geojsonl';
let junctions = [];
if (existsSync(junctionPath)) {
  junctions = loadJunctions(junctionPath);
} else if (existsSync(OUT)) {
  junctions = JSON.parse(readFileSync(OUT, 'utf8')).junctions || [];
}

const payload = {
  updated: TODAY,
  vehicle: '普通車',
  discounts: '休日割引・深夜割引は掛けていません。ETCと現金の通常料金が同じ区間は、その額を使います。',
  nexco: {
    yenPerKm: 24.6,
    terminalYen: 150,
    tax: 1.1,
    source: 'https://www.w-nexco.co.jp/faq/01/',
    note: '対距離制の計算式。公表されている入口・出口の組があるときは計算式を使わない。'
  },
  roads: {
    maebaru: {
      fullYen: 370,
      source: 'https://www.fukuoka-dk.jp/pages/52/',
      note: '福岡前原道路（西九州道）全区間。普通車。ETCも同額。'
    },
    fukuokaUrban: {
      cashYen: 630,
      source: 'https://www.fk-tosikou.or.jp/ryokin/itiran/itiran.shtml',
      note: '全線。ETCは平日7–22時630、土曜590、日祝560、22–7時560。特定区間の減額は入口を特定できないため使わない。'
    },
    kitakyushuUrban: {
      cashYen: 520,
      source: 'https://www.fk-tosikou.or.jp/ryokin/itiran/itiran.shtml',
      note: '全線。ETCは平日7–22時520、土曜510、日祝480、平日・土曜の22–7時500、日祝の夜間480。'
    }
  },
  pairs: PAIRS,
  aliases: [{ from: '延岡南', to: '延岡', yen: 0, source: 'https://kosoku.jp/route.php?c=%E6%99%AE%E9%80%9A%E8%BB%8A&f=%E5%BB%B6%E5%B2%A1%E5%8D%97&t=%E5%BB%B6%E5%B2%A1%EF%BC%AA%EF%BC%A3%EF%BC%B7%E3%83%BB%EF%BC%A9%EF%BC%A3' }],
  junctions
};

writeFileSync(OUT, `${JSON.stringify(payload)}\n`);
console.log(`junctions ${junctions.length} -> ${OUT}`);
