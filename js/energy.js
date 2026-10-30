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

/** Share of the car's max DC power at this state of charge. */
export function leafChargeFactor(soc, { session = 1, hot = false, cold = false } = {}) {
  const s = Math.min(1, Math.max(0, Number(soc) || 0));
  let factor = 0.95;
  if (s >= 0.9) factor = 0.08;
  else if (s >= 0.85) factor = 0.14;
  else if (s >= 0.8) factor = 0.22;
  else if (s >= 0.75) factor = 0.4;
  else if (s >= 0.65) factor = 0.55;
  else if (s >= 0.5) factor = 0.75;
  const nth = Math.max(1, Number(session) || 1);
  if (nth === 2) factor *= 0.72;
  else if (nth >= 3) factor *= 0.55;
  if (hot) factor *= 0.42;
  else if (cold) factor *= 0.8;
  return Math.max(0.05, factor);
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
