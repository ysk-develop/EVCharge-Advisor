/**
 * Route geometry, elevation-adjusted energy, and charging-stop planning.
 * Distances and times come from Valhalla. Yen amounts are never invented here.
 */

import { decodePolyline, haversineKm } from './geo.js';
import {
  resolveChargerPrice,
  estimateSessionCost,
  priceWarnings
} from './charger-price.js';

const DRIVETRAIN = 0.92;
const REGEN = 0.55;

export function estimateMassKg(batteryKwh) {
  return 1300 + Number(batteryKwh) * 8;
}

export function speedFactor(kmh) {
  if (kmh < 30) return 1.12;
  if (kmh < 50) return 1.04;
  if (kmh <= 70) return 1;
  return Math.min(1.55, 1 + 0.008 * (kmh - 60));
}

export function estimateChargeMinutes(startKwh, addKwh, chargerKw, carMaxKw, batteryKwh) {
  if (addKwh <= 0.05) return 0;
  const charger = Number(chargerKw);
  const car = Number(carMaxKw);
  if (!Number.isFinite(charger) || charger <= 0 || !Number.isFinite(car) || car <= 0) return null;
  const cap = Math.min(charger, car);
  const battery = Math.max(Number(batteryKwh) || cap, 1);
  let minutes = 0;
  let socKwh = Math.max(0, startKwh);
  const end = Math.min(battery, socKwh + addKwh);
  const step = Math.max(battery * 0.01, 0.05);
  let guard = 0;
  while (socKwh < end - 1e-6 && guard < 500) {
    const d = Math.min(step, end - socKwh);
    const soc = socKwh / battery;
    let factor = 0.92;
    if (soc >= 0.8) factor = 0.35;
    else if (soc >= 0.55) factor = 0.68;
    const kw = Math.max(cap * factor, 1);
    minutes += (d / kw) * 60;
    socKwh += d;
    guard += 1;
  }
  return Math.max(1, Math.round(minutes));
}

function finiteOrNull(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

export function highwayManeuver(maneuver) {
  if (maneuver?.toll) return true;
  const name = Array.isArray(maneuver?.street_names)
    ? maneuver.street_names.join(' ')
    : String(maneuver?.name || '');
  return /高速道路|自動車道|expressway|首都高|圏央道/i.test(name);
}

function maneuverName(maneuver) {
  const names = maneuver?.street_names || [];
  if (names.length) return String(names[0]);
  return maneuver?.name || '';
}

export function summarizeRoads(maneuvers) {
  const names = [];
  for (const m of maneuvers || []) {
    const n = maneuverName(m);
    if (!n) continue;
    if (m.lengthKm != null && m.lengthKm < 0.4 && names.length) continue;
    if (names[names.length - 1] === n) continue;
    names.push(n);
  }
  if (!names.length) return '主要道路名は取得できませんでした';
  const shown = names.slice(0, 8);
  return shown.join(' → ') + (names.length > 8 ? ' → …' : '');
}

export function parseValhallaTrip(trip, meta = {}) {
  const leg = trip?.legs?.[0];
  if (!leg) throw new Error('ルートが返りませんでした');
  const summary = leg.summary || trip.summary || {};
  const distanceKm = Number(summary.length) || 0;
  const durationSec = Number(summary.time) || 0;
  const maneuvers = (leg.maneuvers || []).map((m) => ({
    lengthKm: Number(m.length) || 0,
    timeSec: Number(m.time) || 0,
    name: maneuverName(m),
    highway: highwayManeuver(m),
    toll: Boolean(m.toll),
    instruction: m.instruction || ''
  }));
  let tollKm = 0;
  let highwayKm = 0;
  for (const m of maneuvers) {
    if (m.toll) tollKm += m.lengthKm;
    if (m.highway) highwayKm += m.lengthKm;
  }
  const shape = leg.shape ? decodePolyline(leg.shape, 6) : [];
  const elevation = Array.isArray(leg.elevation) ? leg.elevation.map((v) => Number(v)) : [];
  return {
    key: meta.key || 'route',
    requestKey: meta.requestKey || meta.key || 'route',
    distanceKm,
    durationSec,
    hasToll: Boolean(summary.has_toll) || tollKm > 0.4,
    hasHighway: Boolean(summary.has_highway) || highwayKm > 0.4,
    hasFerry: Boolean(summary.has_ferry),
    tollKm,
    highwayKm,
    highwayRatio: distanceKm > 0 ? highwayKm / distanceKm : 0,
    maneuvers,
    roadSummary: summarizeRoads(maneuvers),
    shape,
    elevation,
    elevationIntervalM: Number(leg.elevation_interval) || 1000
  };
}

function shapeIndex(shape) {
  const pts = [{ lat: shape[0][0], lon: shape[0][1], km: 0 }];
  let km = 0;
  for (let i = 1; i < shape.length; i += 1) {
    km += haversineKm(shape[i - 1][0], shape[i - 1][1], shape[i][0], shape[i][1]);
    pts.push({ lat: shape[i][0], lon: shape[i][1], km });
  }
  return pts;
}

function stretchPoint(index, routeKm, routeDistanceKm) {
  if (!index?.length) return { lat: null, lon: null };
  const shapeKmTotal = index[index.length - 1].km;
  if (shapeKmTotal <= 0.01 || routeDistanceKm <= 0) return { lat: index[0].lat, lon: index[0].lon };
  const km = Math.min(Math.max(routeKm, 0), routeDistanceKm) / routeDistanceKm * shapeKmTotal;
  return interpolate(index, km);
}

function interpolate(index, km) {
  if (km <= 0) return { lat: index[0].lat, lon: index[0].lon };
  const last = index[index.length - 1];
  if (km >= last.km) return { lat: last.lat, lon: last.lon };
  let lo = 0;
  let hi = index.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (index[mid].km <= km) lo = mid;
    else hi = mid;
  }
  const a = index[lo];
  const b = index[hi];
  const t = (km - a.km) / (b.km - a.km || 1);
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

function speedAt(maneuvers, km) {
  let acc = 0;
  for (let i = 0; i < maneuvers.length; i += 1) {
    const m = maneuvers[i];
    const next = acc + m.lengthKm;
    if (km <= next + 1e-6 || i === maneuvers.length - 1) {
      const hours = m.timeSec / 3600;
      const kmh = hours > 0.0001 ? m.lengthKm / hours : 40;
      return { kmh: Number.isFinite(kmh) ? kmh : 40, highway: m.highway };
    }
    acc = next;
  }
  return { kmh: 40, highway: false };
}

export function buildEnergyProfile(route, vehicle) {
  const distanceKm = route.distanceKm;
  const battery = Number(vehicle.batteryKwh);
  const efficiency = Number(vehicle.efficiencyKmPerKwh);
  const conservative = Number(vehicle.conservativeRangeKm);
  const optimisticWh = 1000 / efficiency;
  const conservativeWh = battery * 1000 / conservative;
  // Flat 60 km/h uses the more pessimistic of the typed efficiency and the
  // conservative full-charge range. Speed and elevation are applied on top.
  const baseWh = Math.max(optimisticWh, conservativeWh);
  const mass = estimateMassKg(battery);
  const whPerMeterPotential = mass * 9.81 / 3600;
  const intervalKm = (route.elevationIntervalM || 1000) / 1000;
  const elevation = route.elevation?.length ? route.elevation : [0, 0];
  const index = route.shape?.length ? shapeIndex(route.shape) : null;

  const raw = [];
  let gainM = 0;
  let lossM = 0;
  let km = 0;
  let cum = 0;
  const segments = Math.max(elevation.length - 1, 1);
  for (let i = 0; i < segments && km < distanceKm - 1e-6; i += 1) {
    let segKm = intervalKm;
    if (!route.elevation?.length) segKm = distanceKm;
    if (km + segKm > distanceKm) segKm = distanceKm - km;
    const a = Number.isFinite(elevation[i]) ? elevation[i] : elevation[i - 1] || 0;
    const b = Number.isFinite(elevation[i + 1]) ? elevation[i + 1] : a;
    const delta = b - a;
    if (delta > 0) gainM += delta;
    else lossM -= delta;
    const { kmh, highway } = speedAt(route.maneuvers || [], km + segKm / 2);
    let wh = segKm * baseWh * speedFactor(kmh);
    if (delta > 0) wh += delta * whPerMeterPotential / DRIVETRAIN;
    else wh -= Math.abs(delta) * whPerMeterPotential * REGEN;
    wh = Math.max(segKm * baseWh * 0.35, wh);
    const pos = stretchPoint(index, km, distanceKm);
    raw.push({
      km,
      lat: pos.lat,
      lon: pos.lon,
      cumKwh: cum,
      elevation: a,
      highway
    });
    cum += wh / 1000;
    km += segKm;
  }
  if (km < distanceKm - 0.05) {
    const segKm = distanceKm - km;
    const { kmh, highway } = speedAt(route.maneuvers || [], km + segKm / 2);
    const wh = segKm * baseWh * speedFactor(kmh);
    const pos = stretchPoint(index, km, distanceKm);
    raw.push({
      km,
      lat: pos.lat,
      lon: pos.lon,
      cumKwh: cum,
      elevation: Number.isFinite(elevation[elevation.length - 1]) ? elevation[elevation.length - 1] : 0,
      highway
    });
    cum += wh / 1000;
  }
  const endPos = stretchPoint(index, distanceKm, distanceKm);
  raw.push({
    km: distanceKm,
    lat: endPos.lat,
    lon: endPos.lon,
    cumKwh: cum,
    elevation: Number.isFinite(elevation[elevation.length - 1]) ? elevation[elevation.length - 1] : 0,
    highway: false
  });

  const samples = raw;
  const totalKwh = samples[samples.length - 1].cumKwh;
  const whPerKm = distanceKm > 0 ? (totalKwh * 1000) / distanceKm : baseWh;

  return {
    distanceKm,
    durationSec: route.durationSec,
    samples,
    totalKwh,
    whPerKm,
    avgKmPerKwh: whPerKm > 0 ? 1000 / whPerKm : 0,
    gainM,
    lossM,
    scale: optimisticWh > 0 ? baseWh / optimisticWh : 1,
    modeledWhPerKm: whPerKm,
    roadSummary: route.roadSummary,
    highwayRatio: route.highwayRatio,
    hasToll: route.hasToll,
    hasFerry: route.hasFerry
  };
}

export function kwhAtKm(samples, km) {
  if (!samples?.length) return 0;
  if (km <= samples[0].km) return samples[0].cumKwh;
  const last = samples[samples.length - 1];
  if (km >= last.km) return last.cumKwh;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].km <= km) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const t = (km - a.km) / (b.km - a.km || 1);
  return a.cumKwh + (b.cumKwh - a.cumKwh) * t;
}

export function pointAlong(profile, km) {
  const samples = profile.samples;
  if (!samples?.length) return { lat: null, lon: null, km };
  if (km <= samples[0].km) return samples[0];
  const last = samples[samples.length - 1];
  if (km >= last.km) return last;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].km <= km) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const t = (km - a.km) / (b.km - a.km || 1);
  return {
    km,
    lat: a.lat == null || b.lat == null ? null : a.lat + (b.lat - a.lat) * t,
    lon: a.lon == null || b.lon == null ? null : a.lon + (b.lon - a.lon) * t
  };
}

function projectOnto(profile, lat, lon) {
  const samples = profile.samples.filter((s) => s.lat != null && s.lon != null);
  if (!samples.length) return null;
  let best = null;
  for (const s of samples) {
    const offKm = haversineKm(lat, lon, s.lat, s.lon);
    if (!best || offKm < best.offKm) best = { km: s.km, offKm, lat: s.lat, lon: s.lon };
  }
  return best;
}

export function placeChargers(profile, chargers, maxOffKm = 8) {
  const placed = [];
  const unplaced = [];
  for (const c of chargers || []) {
    const lat = finiteOrNull(c.lat);
    const lon = finiteOrNull(c.lon);
    if (lat == null || lon == null) {
      unplaced.push({ ...c, reason: '座標不明' });
      continue;
    }
    const proj = projectOnto(profile, lat, lon);
    if (!proj) {
      unplaced.push({ ...c, reason: 'ルート座標なし' });
      continue;
    }
    const row = { ...c, km: proj.km, offKm: proj.offKm };
    if (proj.offKm > maxOffKm) unplaced.push({ ...row, reason: 'ルートから離れている' });
    else placed.push(row);
  }
  placed.sort((a, b) => a.km - b.km);
  return { placed, unplaced };
}

export function chargeWindows(profile, vehicle) {
  const battery = Number(vehicle.batteryKwh);
  const soc = Number(vehicle.socPercent) / 100;
  const reserve = vehicle.safetyMarginKm * profile.whPerKm / 1000;
  let km = 0;
  let energy = battery * soc;
  const windows = [];
  for (let guard = 0; guard < 6; guard += 1) {
    const maxKm = maxReachableKm(profile, km, energy, reserve);
    if (maxKm >= profile.distanceKm - 0.3) break;
    const targetKm = Math.min(profile.distanceKm - 1, km + Math.max(5, (maxKm - km) * 0.65));
    const pt = pointAlong(profile, targetKm);
    windows.push({
      km: Math.round(targetKm * 10) / 10,
      lat: pt.lat == null ? null : Math.round(pt.lat * 1000) / 1000,
      lon: pt.lon == null ? null : Math.round(pt.lon * 1000) / 1000
    });
    energy = battery * 0.8;
    km = targetKm;
  }
  return windows;
}

function maxReachableKm(profile, fromKm, energy, reserve) {
  const dest = profile.distanceKm;
  const needDest = kwhAtKm(profile.samples, dest) - kwhAtKm(profile.samples, fromKm);
  if (energy - needDest >= reserve) return dest;
  let lo = fromKm;
  let hi = dest;
  for (let i = 0; i < 28; i += 1) {
    const mid = (lo + hi) / 2;
    const need = kwhAtKm(profile.samples, mid) - kwhAtKm(profile.samples, fromKm);
    if (energy - need >= reserve) lo = mid;
    else hi = mid;
  }
  return lo;
}

function chooseTarget(arrival, fromKm, profile, vehicle, reserve, priceType) {
  const battery = Number(vehicle.batteryKwh);
  const needDest = (kwhAtKm(profile.samples, profile.distanceKm) - kwhAtKm(profile.samples, fromKm)) + reserve;
  const cap80 = battery * 0.8;
  const cap95 = battery * 0.95;
  if (priceType === 'per_session') {
    const want = needDest > cap80 ? Math.min(cap95, Math.max(needDest, cap80)) : Math.max(cap80, needDest);
    return Math.max(arrival, Math.min(cap95, want));
  }
  if (needDest <= cap95) return Math.max(arrival, needDest);
  return Math.max(arrival, cap95);
}

function scoreCandidate(c, mode) {
  const resolved = c.resolved;
  const unknown = resolved.unitPrice == null;
  const loc = c.locationType || 'unknown';
  if (mode === 'time') {
    const kw = Number(c.powerKw) || 0;
    return (kw > 0 ? -kw : 500) + (loc === 'highway' ? -1 : 0);
  }
  if (mode === 'highway') {
    const locPenalty = loc === 'general' ? 3000 : loc === 'highway' ? 0 : 800;
    const kw = Number(c.powerKw) || 20;
    return locPenalty - kw;
  }
  if (mode === 'local') {
    const locPenalty = loc === 'highway' ? 3000 : 0;
    return locPenalty + (unknown ? 1e6 : (c.previewCost ?? 1e5));
  }
  return unknown ? 1e6 : (c.previewCost ?? 1e5);
}

export function planStops(profile, chargers, vehicle, mode) {
  const battery = Number(vehicle.batteryKwh);
  const start = battery * Number(vehicle.socPercent) / 100;
  const reserve = vehicle.safetyMarginKm * profile.whPerKm / 1000;
  const rangePerKwh = profile.whPerKm > 0 ? 1000 / profile.whPerKm : 0;
  let km = 0;
  let energy = start;
  const stops = [];
  let unreachable = null;

  for (let guard = 0; guard < 8; guard += 1) {
    const maxKm = maxReachableKm(profile, km, energy, reserve);
    if (maxKm >= profile.distanceKm - 0.25) break;
    const candidates = chargers.filter((c) => c.km > km + 0.4 && c.km <= maxKm + 0.05);
    if (!candidates.length) {
      unreachable = {
        km: maxKm,
        message: '安全マージンを残したまま到達できる充電器を特定できませんでした。'
      };
      break;
    }
    const previewed = candidates.map((c) => {
      const arrival = energy - (kwhAtKm(profile.samples, c.km) - kwhAtKm(profile.samples, km));
      const target = chooseTarget(arrival, c.km, profile, vehicle, reserve, c.resolved?.priceType);
      const add = Math.max(0, target - arrival);
      const minutes = estimateChargeMinutes(arrival, add, c.powerKw, vehicle.maxDcKw, battery);
      const cost = estimateSessionCost(c.resolved, minutes, add);
      return { ...c, previewCost: cost == null ? null : cost, previewMin: minutes };
    });
    previewed.sort((a, b) => scoreCandidate(a, mode) - scoreCandidate(b, mode));
    const chosen = previewed[0];
    const arrival = energy - (kwhAtKm(profile.samples, chosen.km) - kwhAtKm(profile.samples, km));
    const target = chooseTarget(arrival, chosen.km, profile, vehicle, reserve, chosen.resolved?.priceType);
    const kwhAdded = Math.max(0, target - Math.max(arrival, 0));
    const minutes = estimateChargeMinutes(Math.max(arrival, 0), kwhAdded, chosen.powerKw, vehicle.maxDcKw, battery);
    const costYen = estimateSessionCost(chosen.resolved, minutes, kwhAdded);
    const backups = previewed.slice(1, 3).map((b) => ({
      name: b.name,
      address: b.address || '',
      km: b.km,
      offKm: b.offKm,
      powerKw: b.powerKw ?? null,
      locationType: b.locationType || 'unknown',
      resolved: b.resolved,
      hours: b.hours || b.resolved?.hours || '',
      hoursConflict: b.hoursConflict || b.resolved?.hoursConflict || ''
    }));
    stops.push({
      name: chosen.name,
      address: chosen.address || '',
      lat: chosen.lat ?? null,
      lon: chosen.lon ?? null,
      km: chosen.km,
      offKm: chosen.offKm,
      powerKw: chosen.powerKw ?? null,
      locationType: chosen.locationType || 'unknown',
      apps: chosen.apps || '',
      hours: chosen.hours || chosen.resolved?.hours || '',
      hoursConflict: chosen.hoursConflict || chosen.resolved?.hoursConflict || '',
      arrivalKwh: arrival,
      arrivalSoc: battery > 0 ? arrival / battery * 100 : null,
      arrivalRangeKm: arrival * rangePerKwh,
      kwhAdded,
      minutes,
      costYen,
      resolved: chosen.resolved,
      warnings: priceWarnings(chosen.resolved, minutes || 0),
      backups
    });
    energy = Math.max(arrival, 0) + kwhAdded;
    km = chosen.km;
  }

  const chargeCosts = stops.map((s) => s.costYen);
  const anyUnknownCost = Boolean(unreachable) || stops.some((s) => s.costYen == null);
  const chargeYen = anyUnknownCost ? null : chargeCosts.reduce((a, b) => a + b, 0);
  const anyUnknownMin = Boolean(unreachable) || stops.some((s) => s.minutes == null);
  const chargeMinutes = anyUnknownMin ? null : stops.reduce((a, s) => a + s.minutes, 0);
  const provisional = stops.some((s) => s.resolved?.provisional);

  return {
    stops,
    unreachable,
    chargeYen,
    chargeMinutes,
    provisional,
    neededCharge: stops.length > 0 || Boolean(unreachable)
  };
}

export function resolveToll(route, aiToll) {
  if (!route.hasToll && (route.tollKm || 0) < 0.5) {
    return {
      known: true,
      provisional: false,
      tollYen: 0,
      note: '有料道路を通らないルートです',
      sources: [],
      from: 'route'
    };
  }
  const sources = (aiToll?.sources || []).filter((u) => /^https?:\/\//i.test(String(u)));
  if (aiToll && aiToll.tollKnown && aiToll.tollYen != null && sources.length && Number.isFinite(Number(aiToll.tollYen))) {
    return {
      known: true,
      provisional: false,
      tollYen: Math.round(Number(aiToll.tollYen)),
      note: aiToll.note || '',
      sources,
      from: 'ai'
    };
  }
  return {
    known: false,
    provisional: false,
    tollYen: null,
    note: aiToll?.note || '通行料金を確認できませんでした',
    sources,
    from: 'unknown'
  };
}

function decorate(item, plan, toll, id, title, blurb) {
  const profile = item.profile;
  const totalYen = toll.known && plan.chargeYen != null ? toll.tollYen + plan.chargeYen : null;
  const totalTimeSec = plan.chargeMinutes != null ? item.route.durationSec + plan.chargeMinutes * 60 : null;
  return {
    id,
    title,
    blurb,
    key: item.key,
    distanceKm: item.route.distanceKm,
    driveSec: item.route.durationSec,
    roadSummary: item.route.roadSummary,
    highwayRatio: item.route.highwayRatio,
    hasFerry: item.route.hasFerry,
    gainM: profile.gainM,
    lossM: profile.lossM,
    totalKwh: profile.totalKwh,
    avgKmPerKwh: profile.avgKmPerKwh,
    scale: profile.scale,
    toll,
    stops: plan.stops,
    unplaced: item.unplaced || [],
    candidates: item.candidates || [],
    unreachable: plan.unreachable,
    chargeYen: plan.chargeYen,
    chargeMinutes: plan.chargeMinutes,
    provisional: plan.provisional || toll.provisional,
    totalYen,
    totalTimeSec,
    neededCharge: plan.neededCharge
  };
}

function dedupeRoutes(items) {
  const out = [];
  for (const item of items) {
    const dup = out.some((o) =>
      Math.abs(o.route.distanceKm - item.route.distanceKm) < 0.4
      && Math.abs(o.route.durationSec - item.route.durationSec) < 20
    );
    if (!dup) out.push(item);
  }
  return out;
}

function patternCost(p) {
  return p.totalYen == null ? Infinity : p.totalYen;
}

export function assembleComparison(items) {
  const unique = dedupeRoutes(items);
  if (!unique.length) throw new Error('比較できるルートがありません');

  const highwayPool = unique.filter((i) => i.route.highwayRatio >= 0.35);
  const highwayGeom = highwayPool.length
    ? highwayPool.reduce((a, b) => (a.route.highwayRatio >= b.route.highwayRatio ? a : b))
    : unique[0];
  const localGeom = unique.find((i) => i.requestKey === 'local')
    || unique.reduce((a, b) => (a.route.highwayRatio <= b.route.highwayRatio ? a : b));
  const timeChoices = [];
  for (const item of unique) {
    for (const plan of Object.values(item.plans)) {
      const known = plan.chargeMinutes != null && !plan.unreachable;
      timeChoices.push({
        item,
        plan,
        seconds: known ? item.route.durationSec + plan.chargeMinutes * 60 : item.route.durationSec + 864000
      });
    }
  }
  const fastestChoice = timeChoices.reduce((a, b) => (a.seconds <= b.seconds ? a : b));

  const costPlanned = unique.map((item) => ({
    item,
    plan: item.plans.cost,
    toll: item.toll
  })).map((row) => decorate(row.item, row.plan, row.toll, 'cheapest', '最安', ''));
  const cheapestKnown = costPlanned.filter((p) => p.totalYen != null);
  const cheapestPlan = (cheapestKnown.length ? cheapestKnown : costPlanned)
    .reduce((a, b) => (patternCost(a) <= patternCost(b) ? a : b));
  const cheapestItem = unique.find((i) => i.key === cheapestPlan.key) || unique[0];

  const fastest = decorate(
    fastestChoice.item,
    fastestChoice.plan,
    fastestChoice.item.toll,
    'fastest',
    '最速',
    '運転と充電を合わせた所要時間が短い組み合わせです。'
  );
  const highway = decorate(
    highwayGeom,
    highwayGeom.plans.highway,
    highwayGeom.toll,
    'highway',
    '高速優先',
    highwayGeom.route.highwayRatio >= 0.7
      ? '高速道路を中心に進むルートです。'
      : '高速道路の比率がいちばん高いルートです。最後まで高速だけ、とは限らない区間があります。'
  );
  const local = decorate(
    localGeom,
    localGeom.plans.local,
    localGeom.toll,
    'local',
    '一般道',
    localGeom.route.hasHighway
      ? '一般道優先ですが、一部で自動車道が残っている可能性があります。'
      : '高速道路と有料道路を避けたルートです。'
  );
  const cheapest = {
    ...decorate(cheapestItem, cheapestItem.plans.cost, cheapestItem.toll, 'cheapest', '最安', ''),
    blurb: cheapestPlan.totalYen == null
      ? '判明している費用がいちばん少ないルートです。通行料金か充電料金が不明なため、合計は不明です。'
      : '通行料金と充電料金の合計がいちばん安いルートです。高速と一般道が混ざる場合があります。'
  };

  const patterns = [cheapest, fastest, highway, local];
  return { patterns, recommendation: recommend(patterns) };
}

function fmtYen(n) {
  if (n == null) return '不明';
  return `${Math.round(n).toLocaleString('ja-JP')}円`;
}

function fmtDuration(sec) {
  if (sec == null) return '不明';
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h <= 0) return `${min}分`;
  return `${h}時間${min}分`;
}

export function formatDuration(sec) {
  return fmtDuration(sec);
}

export function formatYen(n) {
  return fmtYen(n);
}

function recommend(patterns) {
  const named = Object.fromEntries(patterns.map((p) => [p.id, p]));
  const known = patterns.filter((p) => p.totalYen != null);
  const lines = [];
  if (known.length) {
    const best = known.reduce((a, b) => (a.totalYen <= b.totalYen ? a : b));
    lines.push(`合計が出せた中では「${best.title}」が約${fmtYen(best.totalYen)}でいちばん安いです。`);
  } else {
    lines.push('通行料金または充電料金が不明なため、合計金額の最安は断定できません。');
  }
  const timed = patterns.filter((p) => p.totalTimeSec != null);
  if (timed.length) {
    const fast = timed.reduce((a, b) => (a.totalTimeSec <= b.totalTimeSec ? a : b));
    lines.push(`充電時間を含めた所要時間が短いのは「${fast.title}」の約${fmtDuration(fast.totalTimeSec)}です。`);
  } else if (named.fastest) {
    lines.push(`運転時間だけを見ると「最速」は約${fmtDuration(named.fastest.driveSec)}です。充電時間が不明な箇所は合計に入れていません。`);
  }
  if (patterns.some((p) => p.stops.some((s) => s.resolved?.operatorClass === 'emp_partner'))) {
    lines.push('提携充電器（ディーラー等）が候補に入っています。1回定額のことがあり、eMPの標準分課金は使っていません。');
  }
  if (patterns.some((p) => p.provisional)) {
    lines.push('試算や料金マスターの参考値が混ざっている合計は、公式の料金と違うことがあります。');
  }
  return lines.join('');
}

export function attachResolvedChargers(placed, ctx) {
  return placed.map((c) => ({
    ...c,
    resolved: c.resolved || resolveChargerPrice(c, ctx)
  }));
}

export function prepareRouteItem(route, vehicle, chargers, aiToll, ctx) {
  const profile = buildEnergyProfile(route, vehicle);
  const { placed, unplaced } = placeChargers(profile, chargers);
  const resolvedPlaced = attachResolvedChargers(placed, ctx);
  const resolvedUnplaced = unplaced.map((c) => ({
    ...c,
    resolved: resolveChargerPrice(c, ctx)
  }));
  const toll = resolveToll(route, aiToll);
  const plans = {
    cost: planStops(profile, resolvedPlaced, vehicle, 'cost'),
    time: planStops(profile, resolvedPlaced, vehicle, 'time'),
    highway: planStops(profile, resolvedPlaced, vehicle, 'highway'),
    local: planStops(profile, resolvedPlaced, vehicle, 'local')
  };
  return {
    key: route.key,
    requestKey: route.requestKey,
    route,
    profile,
    toll,
    unplaced: resolvedUnplaced,
    candidates: resolvedPlaced,
    plans
  };
}
