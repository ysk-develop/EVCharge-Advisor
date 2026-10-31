/**
 * Leaf-like usable capacity, charge taper, and hot/cold effects.
 * Nominal pack size is not treated as fully usable.
 */

export function usableBatteryKwh(vehicle = {}) {
  const nominal = Number(vehicle.batteryKwh);
  const efficiency = Number(vehicle.efficiencyKmPerKwh);
  const range = Number(vehicle.conservativeRangeKm);
  const nominalUsable = Number.isFinite(nominal) && nominal > 0 ? nominal * 0.93 : 0;
  const meterUsable = range > 0 && efficiency > 0 ? range / efficiency : null;
  const usable = meterUsable == null ? nominalUsable : Math.min(meterUsable, nominalUsable);
  return {
    usableKwh: Math.round(usable * 10) / 10,
    nominalKwh: Number.isFinite(nominal) ? nominal : 0,
    meterKwh: meterUsable == null ? null : Math.round(meterUsable * 10) / 10
  };
}

/**
 * Share of the car's max DC power at this state of charge.
 * Hot band assumption for a Leaf ZE1 40 kWh (no active cooling, RapidGate):
 * once the gauge is hot, a 50 kW CHAdeMO session delivers about 15–25 kW
 * below 80% SOC — slower than the nameplate, and not single-digit kW.
 * Repeated-session heat is part of `heat` and is not multiplied again.
 */
export function leafChargeFactor(soc, { session = 1, hot = false, cold = false, heat = null } = {}) {
  const s = Math.min(1, Math.max(0, Number(soc) || 0));
  let factor = 0.95;
  if (s >= 0.9) factor = 0.08;
  else if (s >= 0.85) factor = 0.14;
  else if (s >= 0.8) factor = 0.22;
  else if (s >= 0.75) factor = 0.4;
  else if (s >= 0.65) factor = 0.55;
  else if (s >= 0.5) factor = 0.75;
  let soaked = heat == null ? NaN : Number(heat);
  if (!Number.isFinite(soaked)) soaked = hot ? 1 : 0;
  soaked = Math.min(1, Math.max(0, soaked));
  if (soaked >= 0.05) {
    let hotFactor = 0.48;
    if (s >= 0.9) hotFactor = 0.22;
    else if (s >= 0.85) hotFactor = 0.28;
    else if (s >= 0.8) hotFactor = 0.3;
    else if (s >= 0.65) hotFactor = 0.36;
    else if (s >= 0.5) hotFactor = 0.42;
    factor = factor * (1 - soaked) + hotFactor * soaked;
  } else {
    const nth = Math.max(1, Number(session) || 1);
    if (nth === 2) factor *= 0.72;
    else if (nth >= 3) factor *= 0.55;
    if (cold) factor *= 0.8;
  }
  return Math.max(0.05, factor);
}

/** eMP visitor sessions are capped around 30 minutes; a hot rapid should stop there. */
export const HOT_RAPID_MAX_MIN = 30;

/** Parked, uncooled pack. About 20 minutes sheds a full soak down toward the air. */
export const PACK_COOL_PER_MIN = 0.04;

export function ambientHeatFloor(ambientC) {
  const c = Number(ambientC);
  if (!Number.isFinite(c) || c < 27) return 0;
  if (c >= 35) return 0.7;
  if (c >= 30) return 0.4;
  return 0.2;
}

/** 1 = red gauge. Highway soak plus earlier rapids in the same hot trip. */
export function soakHeat({ ambientC, km = 0, highwayKm = 0, session = 1 } = {}) {
  const plan = thermalPlan(ambientC);
  let heat = 0;
  if (batteryHotAt(ambientC, km, highwayKm)) heat = plan.extreme ? 1 : 0.9;
  else if (plan.hot) heat = 0.35;
  if (plan.hot && session >= 2) heat = Math.min(1, heat + 0.12 * (session - 1));
  return heat;
}

export function coolDown(heat, ambientC) {
  const floor = ambientHeatFloor(ambientC);
  const soaked = Math.max(0, Number(heat) || 0);
  if (soaked <= floor + 0.08) return { minutes: 0, heat: Math.max(soaked, floor) };
  const minutes = Math.min(20, Math.ceil((soaked - floor) / PACK_COOL_PER_MIN));
  return {
    minutes,
    heat: Math.max(floor, Math.round((soaked - PACK_COOL_PER_MIN * minutes) * 100) / 100)
  };
}

export function consumptionFactor(ambientC) {
  const c = Number(ambientC);
  if (!Number.isFinite(c)) return 1;
  if (c >= 35) return 1.18;
  if (c >= 30) return 1.12;
  if (c >= 26) return 1.06;
  if (c <= 5) return 1.22;
  if (c <= 10) return 1.12;
  if (c <= 15) return 1.05;
  return 1;
}

export function thermalPlan(ambientC) {
  const c = Number(ambientC);
  const known = Number.isFinite(c);
  const extreme = known && c >= 35;
  const hot = known && c >= 30;
  // High 20s still heat an uncooled pack on the expressway. Local roads stay uncapped.
  const warm = known && c >= 27;
  const cold = known && c <= 10;
  return {
    hot: extreme || hot || warm,
    extreme,
    cold,
    /** Highway km before an uncooled pack is treated as hot. */
    onsetHighwayKm: extreme ? 0 : hot ? 30 : warm ? 45 : Infinity
  };
}

export function batteryHotAt(ambientC, km, highwayKm) {
  const plan = thermalPlan(ambientC);
  if (plan.extreme) return km >= 15 || highwayKm >= plan.onsetHighwayKm;
  if (!plan.hot) return false;
  return highwayKm >= plan.onsetHighwayKm;
}

/**
 * Valhalla duration, stretched where a hot uncooled pack is held to 80 km/h.
 */
export function adjustedDriveSec(route, ambientC, highwayAmbientC = ambientC) {
  const plan = thermalPlan(ambientC);
  const highwayPlan = thermalPlan(highwayAmbientC);
  if (!plan.hot && !highwayPlan.hot) return Number(route?.durationSec) || 0;
  let km = 0;
  let highwayKm = 0;
  let sec = 0;
  const maneuvers = route?.maneuvers || [];
  if (!maneuvers.length) return Number(route?.durationSec) || 0;
  for (const maneuver of maneuvers) {
    const len = Number(maneuver.lengthKm) || 0;
    const leg = Number(maneuver.timeSec) || 0;
    const kmh = leg > 1 && len > 0 ? len / (leg / 3600) : 40;
    const steps = Math.max(1, Math.ceil(len / 10) || 1);
    const stepLen = len / steps;
    const stepLeg = leg / steps;
    for (let step = 0; step < steps; step += 1) {
      const at = km + stepLen * (step + 0.5);
      const hwy = highwayKm + (maneuver.highway ? stepLen * (step + 0.5) : 0);
      const air = maneuver.highway ? highwayAmbientC : ambientC;
      const hot = batteryHotAt(air, at, hwy);
      const limited = hot && (maneuver.highway || thermalPlan(air).extreme) && kmh > 80;
      sec += limited ? (stepLen / 80) * 3600 : stepLeg;
    }
    if (maneuver.highway) highwayKm += len;
    km += len;
  }
  return sec;
}
