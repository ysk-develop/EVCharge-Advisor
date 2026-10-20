/**
 * Geocoding and polyline helpers. Browser-only network calls.
 */

export function decodePolyline(str, precision = 6) {
  const factor = 10 ** precision;
  let index = 0;
  let lat = 0;
  let lon = 0;
  const out = [];
  while (index < str.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      if (index >= str.length) break;
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;

    result = 0;
    shift = 0;
    do {
      if (index >= str.length) break;
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const dlon = (result & 1) ? ~(result >> 1) : (result >> 1);
    lon += dlon;
    out.push([lat / factor, lon / factor]);
  }
  return out;
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

export function normalizePlace(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s　・,，.。/／\-‐−]/g, '');
}

function scoreLabel(query, label) {
  const q = normalizePlace(query);
  const l = normalizePlace(label);
  if (!q || !l) return 0;
  if (q === l) return 100;
  if (l.includes(q) || q.includes(l)) return 80;
  let score = 0;
  const parts = String(query).split(/[\s　]+/).filter((p) => p.length >= 2);
  for (const part of parts) {
    if (label.includes(part)) score += 15;
  }
  if (q.length >= 3 && l.includes(q.slice(0, 3))) score += 10;
  return score;
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function searchNominatim(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&countrycodes=jp&limit=5&accept-language=ja`;
  const data = await fetchJson(url, { Accept: 'application/json' });
  return (data || []).map((row) => ({
    lat: Number(row.lat),
    lon: Number(row.lon),
    label: row.display_name || query,
    provider: 'nominatim',
    score: scoreLabel(query, row.display_name || '') + (Number(row.importance) || 0) * 10
  })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

async function searchGsi(query) {
  const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`;
  const data = await fetchJson(url);
  return (Array.isArray(data) ? data : []).slice(0, 5).map((row) => {
    const coords = row.geometry?.coordinates || [];
    const label = row.properties?.title || query;
    return {
      lat: Number(coords[1]),
      lon: Number(coords[0]),
      label,
      provider: 'gsi',
      score: scoreLabel(query, label)
    };
  }).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon) && r.score >= 15);
}

export async function geocode(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('住所を入力してください');

  const settled = await Promise.allSettled([searchNominatim(q), searchGsi(q)]);
  const hits = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') hits.push(...s.value);
  }
  hits.sort((a, b) => b.score - a.score);
  if (!hits.length || hits[0].score < 10) {
    throw new Error(`「${q}」の場所が見つかりませんでした。市区町村まで入れてください`);
  }
  const best = hits[0];
  return {
    lat: best.lat,
    lon: best.lon,
    label: best.label,
    provider: best.provider
  };
}
