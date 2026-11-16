// Driver-break alerts: buses parked in one spot for a long time (layovers, driver breaks).
// Why it matters: while a bus sits, TransLoc's countdowns at the next stops freeze
// (seen 2026-11-13: a Silver bus parked 8 min at JPJ South Lot, the next stop said "1 min"
// the whole time). So we tell riders the bus is parked and its time may slip.
// Free: uses only the bus data we already fetch.

import { metersBetween } from './trips.js';

const SLOW_MPH = 2; // slower than this counts as not moving
const SAME_SPOT_M = 60; // moved less than this from where it stopped = same spot
const PARKED_AFTER_MS = 4 * 60_000; // normal stops and schedule holds (2-3 min) don't count
const NEAR_STOP_M = 100; // parked within this of a stop = "at <stop>"

// One tracker for live data and one for demo mode.
export function makeParkTracker() {
  const spots = new Map(); // vehicleId -> { lat, lng, since, routeId, lastSeen }

  return {
    update(vehicles) {
      const now = Date.now();
      const seen = new Set();
      for (const v of vehicles) {
        seen.add(v.id);
        const spot = spots.get(v.id);
        const still = v.speed <= SLOW_MPH;
        if (still && spot && spot.routeId === v.routeId && metersBetween(spot, v) < SAME_SPOT_M) {
          spot.lastSeen = now;
        } else if (still) {
          spots.set(v.id, { lat: v.lat, lng: v.lng, since: now, routeId: v.routeId, lastSeen: now });
        } else {
          spots.delete(v.id);
        }
      }
      for (const id of spots.keys()) if (!seen.has(id)) spots.delete(id); // bus left service
    },

    // How long has this bus been sitting still in one spot? (0 if moving)
    stillForMs(vehicleId) {
      const spot = spots.get(vehicleId);
      return spot ? Date.now() - spot.since : 0;
    },

    // Buses parked long enough to mention:
    // [{ vehicleId, routeId, sinceMs, stopId, stopName, atRouteStart }]
    current(routes, stops) {
      const now = Date.now();
      const out = [];
      for (const [vehicleId, spot] of spots) {
        if (now - spot.since < PARKED_AFTER_MS) continue;
        const route = routes.find((r) => r.id === spot.routeId);
        // Nearest stop, preferring this route's own stops.
        const own = new Set(route?.stopIds || []);
        let best = null;
        for (const s of stops) {
          const m = metersBetween(spot, s) - (own.has(s.id) ? 30 : 0);
          if (m <= NEAR_STOP_M && (!best || m < best.m)) best = { s, m };
        }
        out.push({
          vehicleId,
          routeId: spot.routeId,
          sinceMs: spot.since,
          stopId: best?.s.id ?? null,
          stopName: best?.s.name ?? null,
          // Parked where its route starts = almost surely a layover / driver break.
          atRouteStart: Boolean(best && route?.stopIds?.[0] === best.s.id),
        });
      }
      return out;
    },
  };
}
