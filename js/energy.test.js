import assert from 'node:assert/strict';
import { usableBatteryKwh, leafChargeFactor, consumptionFactor, adjustedDriveSec, batteryHotAt } from './energy.js';
import { estimateChargeMinutes } from './route-model.js';
import { kyushuNormalC, estimateAmbientC } from './climate.js';

const fresh = usableBatteryKwh({
  batteryKwh: 40,
  efficiencyKmPerKwh: 5.5,
  conservativeRangeKm: 220
});
assert.equal(fresh.meterKwh, 40);
assert.equal(fresh.usableKwh, 37.2);

const worn = usableBatteryKwh({
  batteryKwh: 40,
  efficiencyKmPerKwh: 5.5,
  conservativeRangeKm: 180
});
assert.equal(worn.usableKwh, 32.7);
assert.equal(usableBatteryKwh({ batteryKwh: 40 }).usableKwh, 37.2);

assert.ok(leafChargeFactor(0.3) > leafChargeFactor(0.86));
assert.ok(leafChargeFactor(0.4, { session: 1 }) > leafChargeFactor(0.4, { session: 2 }));
assert.ok(leafChargeFactor(0.4) > leafChargeFactor(0.4, { hot: true }));
assert.ok(leafChargeFactor(0.4) > leafChargeFactor(0.4, { cold: true }));

const low = estimateChargeMinutes(8, 10, 50, 50, 37.2, { session: 1 });
const high = estimateChargeMinutes(29, 6, 50, 50, 37.2, { session: 1 });
const second = estimateChargeMinutes(8, 10, 50, 50, 37.2, { session: 2 });
const hot = estimateChargeMinutes(8, 10, 50, 50, 37.2, { session: 2, hot: true });
assert.ok(high / 6 > low / 10, `taper ${high} min/6kWh should be slower than ${low} min/10kWh`);
assert.ok(second > low);
assert.ok(hot > second);

assert.ok(kyushuNormalC(new Date('2026-08-12T15:00:00')) >= 32);
assert.ok(kyushuNormalC(new Date('2026-10-30T10:00:00')) < 26);
assert.ok(consumptionFactor(33) > consumptionFactor(18));
assert.ok(consumptionFactor(5) > consumptionFactor(18));
assert.ok(consumptionFactor(36) > consumptionFactor(28));

const route = { durationSec: 3600, maneuvers: [{ lengthKm: 100, timeSec: 3600, highway: true }] };
const local = { durationSec: 3600, maneuvers: [{ lengthKm: 100, timeSec: 3600, highway: false }] };
assert.equal(adjustedDriveSec(route, 18), 3600);
assert.ok(adjustedDriveSec(route, 28) > 3600, 'warm expressway is held near 80 km/h once the pack heats');
assert.ok(adjustedDriveSec(route, 36) > adjustedDriveSec(route, 28));
assert.equal(adjustedDriveSec(local, 28), 3600);
assert.ok(adjustedDriveSec(local, 36) > 3600, 'extreme heat also caps local roads');
assert.equal(batteryHotAt(28, 20, 20), false);
assert.equal(batteryHotAt(28, 80, 50), true);
assert.equal(batteryHotAt(36, 20, 0), true);
assert.equal(batteryHotAt(18, 80, 80), false);

const mixedHeat = {
  durationSec: 7200,
  maneuvers: [
    { lengthKm: 100, timeSec: 3600, highway: true },
    { lengthKm: 50, timeSec: 3600, highway: false }
  ]
};
assert.ok(adjustedDriveSec(mixedHeat, 20, 36) > 7200);
assert.equal(adjustedDriveSec(mixedHeat, 20, 20), 7200);

const archived = await estimateAmbientC(
  [{ lat: 33.5, lon: 130.2 }, { lat: 32.5, lon: 131.6 }],
  '2026-08-07T15:00',
  async (url) => ({
    ok: true,
    json: async () => ({
      hourly: {
        time: ['2026-08-07T15:00'],
        temperature_2m: [String(url).includes('33.5') ? 36 : 28]
      }
    })
  })
);
assert.equal(archived.source, 'archive');
assert.equal(archived.c, 32);
assert.equal(archived.departureC, 36);
assert.ok(archived.highwayC >= 35);
assert.equal(archived.hot, true);

console.log('energy tests ok', { low, high, second, hot });
