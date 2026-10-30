/**
 * On-device tolls for Kyushu. Published IC pairs and flat toll roads win.
 * The NEXCO distance formula is only a fallback and is tagged 想定.
 */
import { haversineKm } from './geo.js';

let pending = null;

export function resetTollTable() {
  pending = null;
}

export async function loadTollTable() {
  if (!pending) {
    pending = fetch(new URL('../data/tolls-kyushu.json', import.meta.url))
      .then((res) => {
        if (!res.ok) throw new Error(`料金表を読めません（HTTP ${res.status}）`);
        return res.json();
      })
      .catch((err) => {
        pending = null;
        throw err;
      });
  }
  return pending;
}

export function nexcoOrdinaryYen(km) {
  const distance = Number(km);
  if (!(distance > 0)) return 0;
  const rate = 24.6;
  let variable;
  if (distance <= 100) variable = distance * rate;
  else if (distance <= 200) variable = (0.75 + 25 / distance) * distance * rate;
  else variable = (0.7 + 35 / distance) * distance * rate;
  const withTax = (variable + 150) * 1.1;
  if (withTax > 10000) return Math.floor(withTax / 100) * 100;
  return Math.round(withTax / 10) * 10;
}

function clock(departIso) {
  const date = new Date(departIso || '');
  if (Number.isNaN(date.getTime())) return { hour: 10, day: 3 };
  return { hour: date.getHours(), day: date.getDay() };
}

export function fukuokaUrbanYen(departIso, hasEtc = true) {
  if (!hasEtc) return 630;
  const { hour, day } = clock(departIso);
  if (hour >= 22 || hour < 7) return 560;
  if (day === 0) return 560;
  if (day === 6) return 590;
  return 630;
}

export function kitakyushuUrbanYen(departIso, hasEtc = true) {
  if (!hasEtc) return 520;
  const { hour, day } = clock(departIso);
  if (day === 0) return 480;
  if (hour >= 22 || hour < 7) return 500;
  if (day === 6) return 510;
  return 520;
}

export function roadClass(name) {
  const text = String(name || '').trim();
  if (/福岡都市高速/.test(text) || /^(?:C|[1-5])$/.test(text)) return 'fukuoka';
  if (/北九州都市高速/.test(text)) return 'kitakyushu';
  if (/西九州|福岡前原|今宿道路|\bE35\b/.test(text)) return 'maebaru';
  if (/\bE77\b|九州中央/.test(text)) return 'freeway';
  if (/九州自動車道|大分自動車道|東九州自動車道|山陽自動車道|長崎自動車道|宮崎自動車道|\bE(?:2|3|10|34|78)\b/.test(text)) return 'nexco';
  return 'other';
}

function pointAtKm(route, km) {
  const shape = route?.shape || [];
  if (shape.length < 2) return null;
  const lengths = [];
  let total = 0;
  for (let i = 1; i < shape.length; i += 1) {
    const step = haversineKm(shape[i - 1][0], shape[i - 1][1], shape[i][0], shape[i][1]);
    lengths.push(step);
    total += step;
  }
  if (total < 0.05) return { lat: shape[0][0], lon: shape[0][1] };
  const routeKm = route.distanceKm > 0 ? route.distanceKm : total;
  const target = Math.min(Math.max(km, 0), routeKm) / routeKm * total;
  let walked = 0;
  for (let i = 0; i < lengths.length; i += 1) {
    const step = lengths[i];
    if (walked + step >= target - 1e-6) {
      const t = step > 0 ? (target - walked) / step : 0;
      return {
        lat: shape[i][0] + (shape[i + 1][0] - shape[i][0]) * t,
        lon: shape[i][1] + (shape[i + 1][1] - shape[i][1]) * t
      };
    }
    walked += step;
  }
  const last = shape[shape.length - 1];
  return { lat: last[0], lon: last[1] };
}

function nearestJunction(junctions, point) {
  if (!point) return null;
  let best = null;
  for (const junction of junctions || []) {
    const distance = haversineKm(point.lat, point.lon, junction.lat, junction.lon);
    if (distance <= 8 && (!best || distance < best.distance)) best = { junction, distance };
  }
  return best?.junction || null;
}

function publishedPair(table, fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return null;
  return (table.pairs || []).find((pair) =>
    (pair.from === fromKey && pair.to === toKey) || (pair.from === toKey && pair.to === fromKey)
  ) || null;
}

function groupsOf(route) {
  const groups = [];
  let cursor = 0;
  let gap = 0;
  let unknownKm = 0;
  for (const maneuver of route?.maneuvers || []) {
    const len = Number(maneuver.lengthKm) || 0;
    const cls = roadClass(maneuver.name);
    if (cls === 'other' || cls === 'freeway') {
      if (cls === 'other' && maneuver.toll && len >= 8) unknownKm += len;
      gap += len;
      cursor += len;
      continue;
    }
    const last = groups[groups.length - 1];
    if (last && last.cls === cls && gap < 1.5) {
      last.km += gap + len;
      last.endKm = cursor + len;
    } else {
      groups.push({ cls, km: len, startKm: cursor, endKm: cursor + len });
    }
    gap = 0;
    cursor += len;
  }
  return { groups, unknownKm };
}

function nexcoPiece(route, group, table, hasEtc) {
  const entry = nearestJunction(table.junctions, pointAtKm(route, group.startKm));
  const exit = nearestJunction(table.junctions, pointAtKm(route, group.endKm));
  if (entry?.key && exit?.key && entry.key === exit.key) {
    const alias = (table.aliases || []).find((row) => row.to === entry.key || row.from === entry.key);
    return { yen: 0, provisional: false, source: alias?.source || '' };
  }
  const pair = publishedPair(table, entry?.key, exit?.key);
  if (pair) {
    const yen = hasEtc && pair.etcYen != null ? pair.etcYen : pair.yen;
    return { yen, provisional: false, source: pair.source };
  }
  return { yen: nexcoOrdinaryYen(group.km), provisional: true, source: table.nexco?.source || '' };
}

export function tollForRoute(route, table, options = {}) {
  const hasEtc = options.hasEtc !== false;
  const { groups, unknownKm } = groupsOf(route);
  if (unknownKm >= 8) {
    return {
      routeId: route.key,
      tollKnown: false,
      tollYen: null,
      provisional: false,
      from: 'table',
      sources: [],
      note: ''
    };
  }
  let yen = 0;
  let provisional = false;
  const sources = [];
  let pieces = 0;
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const next = groups[i + 1]?.cls || '';
    let piece = null;
    if (group.cls === 'maebaru' && group.km >= 12) {
      piece = { yen: table.roads?.maebaru?.fullYen ?? 370, provisional: false, source: table.roads?.maebaru?.source || '' };
    } else if (group.cls === 'maebaru' && group.km >= 3 && group.km < 8 && next === 'fukuoka') {
      piece = { yen: 150, provisional: false, source: table.roads?.maebaru?.source || '' };
    } else if (group.cls === 'maebaru' && group.km >= 6) {
      piece = { yen: 220, provisional: true, source: table.roads?.maebaru?.source || '' };
    } else if (group.cls === 'fukuoka' && group.km >= 1) {
      piece = { yen: fukuokaUrbanYen(options.departIso, hasEtc), provisional: false, source: table.roads?.fukuokaUrban?.source || '' };
    } else if (group.cls === 'kitakyushu' && group.km >= 1) {
      piece = { yen: kitakyushuUrbanYen(options.departIso, hasEtc), provisional: false, source: table.roads?.kitakyushuUrban?.source || '' };
    } else if (group.cls === 'nexco' && group.km >= 2) {
      piece = nexcoPiece(route, group, table, hasEtc);
    }
    if (!piece) continue;
    yen += piece.yen;
    pieces += 1;
    if (piece.provisional) provisional = true;
    if (piece.source) sources.push(piece.source);
  }
  if (!pieces) {
    return {
      routeId: route.key,
      tollKnown: true,
      tollYen: 0,
      provisional: false,
      from: 'table',
      sources: [],
      note: ''
    };
  }
  return {
    routeId: route.key,
    tollKnown: true,
    tollYen: yen,
    provisional,
    from: 'table',
    sources: [...new Set(sources)],
    note: ''
  };
}

export function tollsForRoutes(routes, table, options = {}) {
  return (routes || []).map((route) => tollForRoute(route, table, options));
}
