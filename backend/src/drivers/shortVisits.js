/* Halts at a restaurant that were too short to be a delivery.
 *
 * The rule: during a ride, a restaurant counts as visited only if the driver
 * stayed at least visitMinDwellSec (2 minutes, and never less). Anything
 * shorter is a MISSED DELIVERY, and it is reported as one rather than simply
 * not appearing: "stopped 50 s at Hotel Sai Palace — under 2 min".
 *
 * A halt is consecutive usable fixes inside a restaurant's geofence, at least
 * two of them, at walking pace or slower, spanning at least SHORT_MIN_SEC.
 * Driving past at road speed is not a halt. A halt inside a proper stop at
 * that restaurant (one long enough to be a visit) is not reported. Pure.
 */
'use strict';

const { haversineM } = require('./geo');

const SHORT_MIN_SEC = 20;     // under this it is a slowdown, not a halt
const SLOW_MPS = 2.5;         // ~9 km/h: walking pace, or a vehicle stopping

function detectShortVisits(points, restaurants, visits, cfg) {
  const usable = (points || []).filter((p) => p.countDistance);
  const places = (restaurants || []).filter((r) => r.active !== false && Number.isFinite(r.lat) && Number.isFinite(r.lng));
  const minVisit = Math.max(120, cfg.visitMinDwellSec || 120);
  const out = [];
  for (const r of places) {
    const radius = r.radiusM || cfg.geofenceDefaultRadiusM;
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        const startTs = run[0].deviceTs; const endTs = run[run.length - 1].deviceTs;
        const dwellSec = Math.round((endTs - startTs) / 1000);
        const slow = run.filter((p) => !Number.isFinite(p.speedMps) || p.speedMps <= SLOW_MPS).length >= Math.max(2, Math.ceil(run.length / 2));
        const coveredByVisit = (visits || []).some((v) => v.placeId === r.id && v.startTs <= endTs && v.endTs >= startTs);
        if (slow && dwellSec >= SHORT_MIN_SEC && dwellSec < minVisit && !coveredByVisit) {
          out.push({ placeId: r.id, placeName: r.name, customerId: r.customerId || null, startTs, endTs, dwellSec,
            lat: r.lat, lng: r.lng, minSec: minVisit });
        }
      }
      run = [];
    };
    for (const p of usable) {
      if (haversineM(p, r) <= radius) run.push(p); else flush();
    }
    flush();
  }
  return out.sort((a, b) => a.startTs - b.startTs);
}

module.exports = { detectShortVisits, SHORT_MIN_SEC, SLOW_MPS };
