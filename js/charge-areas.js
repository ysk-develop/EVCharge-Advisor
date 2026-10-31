/**
 * Where the car would fall to about 20–30% SOC, as a short stretch of road.
 * Patterns that need a charge in the same place share one search.
 */
import { haversineKm } from './geo.js';
import { kwhAtKm, pointAlong } from './route-model.js';
import { usableBatteryKwh } from './energy.js';

function kmAtRemaining(profile, fromKm, energy, targetKwh) {
  const base = kwhAtKm(profile.samples, fromKm);
  const need = energy - targetKwh + base;
  if (kwhAtKm(profile.samples, profile.distanceKm) < need - 0.05) return null;
  let lo = fromKm;
  let hi = profile.distanceKm;
  for (let i = 0; i < 26; i += 1) {
    const mid = (lo + hi) / 2;
    if (kwhAtKm(profile.samples, mid) >= need) hi = mid;
    else lo = mid;
  }
  if (hi <= fromKm + 0.8) return null;
  return hi;
}

export function roadAtKm(route, km) {
  let acc = 0;
  let name = '';
  let highway = false;
  for (const maneuver of route?.maneuvers || []) {
    const next = acc + (Number(maneuver.lengthKm) || 0);
    if (km <= next + 0.3) {
      return {
        name: maneuver.name || name || route.roadSummary || '',
        highway: Boolean(maneuver.highway)
      };
    }
    acc = next;
    if (maneuver.name) name = maneuver.name;
    highway = Boolean(maneuver.highway);
  }
  return { name: name || route?.roadSummary || '', highway };
}

export function etaAtKm(route, departIso, km) {
  const depart = new Date(departIso || '');
  if (Number.isNaN(depart.getTime())) return null;
  const frac = route.distanceKm > 0 ? Math.min(1, Math.max(0, km / route.distanceKm)) : 0;
  return new Date(depart.getTime() + (Number(route.durationSec) || 0) * frac * 1000);
}

export function socChargeAreas(profile, vehicle) {
  const battery = usableBatteryKwh(vehicle).usableKwh || Number(vehicle.batteryKwh);
  if (!(battery > 0) || !profile?.samples?.length) return [];
  const high = battery * 0.3;
  const low = battery * 0.2;
  let energy = battery * Number(vehicle.socPercent) / 100;
  let km = 0;
  const areas = [];
  for (let guard = 0; guard < 3; guard += 1) {
    const kmLow = kmAtRemaining(profile, km, energy, low);
    if (kmLow == null || kmLow >= profile.distanceKm - 1) break;
    const kmHigh = kmAtRemaining(profile, km, energy, high);
    const endKm = Math.min(profile.distanceKm - 0.5, kmLow);
    const startKm = Math.max(km + 1, (kmHigh == null ? endKm - 25 : kmHigh));
    const fromKm = Math.max(km + 1, Math.min(startKm, endKm - 8));
    const toKm = Math.min(profile.distanceKm - 0.5, Math.max(endKm, fromKm + 20));
    const mid = Math.min(toKm, fromKm + Math.max(8, (toKm - fromKm) / 2));
    const point = pointAlong(profile, mid);
    if (point.lat == null) break;
    areas.push({
      km: Math.round(mid * 10) / 10,
      fromKm: Math.round(fromKm * 10) / 10,
      toKm: Math.round(toKm * 10) / 10,
      lat: Math.round(point.lat * 1000) / 1000,
      lon: Math.round(point.lon * 1000) / 1000
    });
    energy = battery * 0.8;
    km = toKm;
  }
  return areas;
}

export function areasForRoutes(routes, profiles, vehicle, departIso) {
  const raw = [];
  routes.forEach((route, index) => {
    const profile = profiles[index];
    for (const area of socChargeAreas(profile, vehicle)) {
      const road = roadAtKm(route, area.km);
      raw.push({
        ...area,
        routeKey: route.key,
        road: road.name,
        highway: road.highway || route.highwayRatio >= 0.45,
        eta: etaAtKm(route, departIso, area.km)
      });
    }
  });
  return dedupeAreas(raw);
}

export function dedupeAreas(areas) {
  const out = [];
  for (const area of areas) {
    if (area.lat == null || area.lon == null) continue;
    const hit = out.find((other) => haversineKm(other.lat, other.lon, area.lat, area.lon) < 18);
    if (!hit) {
      out.push({
        ...area,
        routeKeys: [area.routeKey].filter(Boolean),
        roads: area.road ? [area.road] : []
      });
      continue;
    }
    if (area.routeKey && !hit.routeKeys.includes(area.routeKey)) hit.routeKeys.push(area.routeKey);
    if (area.road && !hit.roads.includes(area.road)) hit.roads.push(area.road);
    if (area.highway) hit.highway = true;
  }
  return out.slice(0, 6);
}

export function openAt(hours, date) {
  const text = String(hours || '');
  if (!text.trim() || !date) return null;
  if (/24\s*時間|24h|00:00\s*[-~〜]\s*24:00|0:00\s*[-~〜]\s*24:00/i.test(text)) return true;
  const match = text.match(/(\d{1,2}):(\d{2})\s*[-~〜]\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  const now = date.getHours() * 60 + date.getMinutes();
  if (end >= start) return now >= start && now <= end;
  return now >= start || now <= end;
}

export function scoreAreaCandidate(candidate, area, vehicle) {
  const off = Number.isFinite(candidate.offKm) ? candidate.offKm : 8;
  let score = -off * 8;
  const kw = Number(candidate.powerKw) || 0;
  const cap = Number(vehicle?.maxDcKw) || 90;
  const useful = Math.min(kw || 0, Math.min(cap, 90));
  if (kw > 0) score += useful;
  if (kw > 90) score -= (kw - 90) * 0.15;
  if (area?.highway && candidate.locationType === 'highway') score += 6;
  if (area && !area.highway && candidate.locationType === 'general') score += 12;
  const opened = openAt(candidate.hours, area?.eta);
  if (opened === true) score += 18;
  if (opened === false) score -= 36;
  return score;
}

export function pickBestCandidate(candidates, area, vehicle) {
  const ranked = (candidates || [])
    .filter((candidate) => candidate?.name)
    .map((candidate) => ({ candidate, score: scoreAreaCandidate(candidate, area, vehicle) }))
    .sort((a, b) => b.score - a.score);
  return {
    best: ranked[0]?.candidate || null,
    others: ranked.slice(1, 3).map((row) => row.candidate)
  };
}
