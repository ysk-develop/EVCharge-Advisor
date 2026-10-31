/**
 * Trip temperature without an API key.
 * Open-Meteo forecast for near dates, archive averages otherwise,
 * then built-in Kyushu monthly normals.
 */

export const KYUSHU_AFTERNOON_C = [10, 11, 15, 20, 24, 27, 32, 33, 29, 24, 18, 13];
export const KYUSHU_MORNING_C = [4, 5, 8, 12, 17, 21, 25, 26, 22, 16, 11, 6];

export function kyushuNormalC(date) {
  const month = date.getMonth();
  const hour = date.getHours();
  const afternoon = hour >= 11 && hour < 18;
  const table = afternoon ? KYUSHU_AFTERNOON_C : KYUSHU_MORNING_C;
  return table[month];
}

function hourTemp(payload, isoHour) {
  const times = payload?.hourly?.time || [];
  const temps = payload?.hourly?.temperature_2m || [];
  const idx = times.findIndex((stamp) => String(stamp).startsWith(isoHour));
  if (idx < 0) return null;
  const value = Number(temps[idx]);
  return Number.isFinite(value) ? value : null;
}

async function readTemps(url, isoHour, fetchFn) {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`気温 ${res.status}`);
  const data = await res.json();
  return hourTemp(data, isoHour);
}

export async function estimateAmbientC(points, departIso, fetchFn = fetch) {
  const when = new Date(departIso || '');
  if (Number.isNaN(when.getTime())) {
    return { c: 20, source: 'normal', hot: false, extreme: false, cold: false };
  }
  const day = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
  const hour = `${day}T${String(when.getHours()).padStart(2, '0')}`;
  const aheadDays = (when.getTime() - Date.now()) / 86400000;
  const sample = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon)).slice(0, 5);
  let source = 'normal';
  let values = [];
  try {
    if (sample.length && aheadDays >= -1 && aheadDays <= 15) {
      source = 'forecast';
      values = await Promise.all(sample.map((p) => readTemps(
        `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&hourly=temperature_2m&timezone=Asia%2FTokyo&start_date=${day}&end_date=${day}`,
        hour,
        fetchFn
      )));
    } else if (sample.length) {
      source = 'archive';
      values = await Promise.all(sample.map((p) => readTemps(
        `https://archive-api.open-meteo.com/v1/archive?latitude=${p.lat}&longitude=${p.lon}&hourly=temperature_2m&timezone=Asia%2FTokyo&start_date=${day}&end_date=${day}`,
        hour,
        fetchFn
      )));
    }
  } catch {
    values = [];
  }
  const nums = values.filter((n) => n != null);
  const fallback = kyushuNormalC(when);
  const c = nums.length
    ? Math.round(nums.reduce((sum, n) => sum + n, 0) / nums.length)
    : fallback;
  if (!nums.length) source = 'normal';
  const departureC = nums[0] ?? c;
  const peak = nums.length ? Math.max(...nums) : c;
  // Trip average feeds cabin load. An uncooled pack keeps the hottest air it drove through.
  const highwayC = Math.round(Math.max(c, departureC, peak));
  return {
    c,
    departureC: Math.round(departureC),
    peak: Math.round(peak),
    highwayC,
    source,
    hot: c >= 30 || highwayC >= 35,
    extreme: c >= 35,
    cold: c <= 10
  };
}
