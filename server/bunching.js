// Bunching alerts: two (or more) buses on the same route running right behind each other.
// Riders see them arrive together, then wait a long time for the next one.
//
// How: every time we get bus positions, place each bus on its route's line ("how far along
// the loop is it?"), sort them, and look at the gaps between neighbors. If buses were evenly
// spread, each gap would be loopLength / numberOfBuses. A gap far smaller than that = bunched.
// A bunch must last BUNCH_MIN_MS before we show it (buses briefly pass at shared stops).
// Free: uses only the bus data we already fetch.

import { decodeLine } from './reports.js';
import { metersBetween } from './trips.js';

const BUNCH_MAX_M = 500; // bunched buses are at most this far apart along the route...
const BUNCH_SHARE = 0.25; // ...and closer than a quarter of the "even" spacing
const BUNCH_MIN_MS = 2 * 60_000; // must stay bunched this long before we show it
const FORGET_MS = 30_000; // a bunch not seen for this long is over
const PARKED_MS = 3 * 60_000; // buses stopped this long are on a break/layover: ignore them
const ON_LINE_M = 150; // further than this from the line = off route (detour): ignore
const MOVING_MPH = 2; // below this, TransLoc's heading isn't trustworthy
const AVG_SPEED_MS = 4.5; // typical UVA bus speed including stops (~10 mph), for "about X min"

// Route line → points + how far along the line each point is (meters), cached.
const shapes = new Map();
function shapeOf(encoded) {
  if (shapes.has(encoded)) return shapes.get(encoded);
  const pts = decodeLine(encoded);
  const along = [0];
  for (let k = 1; k < pts.length; k++) along.push(along[k - 1] + metersBetween(pts[k - 1], pts[k]));
  const length = along.at(-1);
  // Most UVA routes are loops (the line ends where it starts).
  const isLoop = pts.length > 2 && metersBetween(pts[0], pts.at(-1)) < 200;
  const shape = { pts, along, length, isLoop };
  if (shapes.size > 100) shapes.clear();
  shapes.set(encoded, shape);
  return shape;
}

const angleDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

// Where along the line is this bus? Many routes use the same street in both directions,
// so we prefer the part of the line going the way the bus is heading. Stopped buses
// (heading unreliable) prefer the spot nearest to where we last placed them.
function placeOnLine(v, shape, lastAlong) {
  const { pts, along, length, isLoop } = shape;
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos((v.lat * Math.PI) / 180);
  const moving = v.speed > MOVING_MPH;
  let best = null;
  for (let k = 1; k < pts.length; k++) {
    const ax = (pts[k - 1].lng - v.lng) * mPerLng, ay = (pts[k - 1].lat - v.lat) * mPerLat;
    const bx = (pts[k].lng - v.lng) * mPerLng, by = (pts[k].lat - v.lat) * mPerLat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (!len2) continue;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const dist = Math.hypot(ax + t * dx, ay + t * dy);
    if (dist > ON_LINE_M) continue;
    const pos = along[k - 1] + t * (along[k] - along[k - 1]);
    let score = dist;
    if (moving) {
      const bearing = (Math.atan2(dx, dy) * 180) / Math.PI; // 0 = north, like TransLoc
      if (angleDiff(v.heading, bearing) > 90) score += 1_000; // wrong direction of travel
    } else if (lastAlong != null) {
      let jump = Math.abs(pos - lastAlong);
      if (isLoop) jump = Math.min(jump, length - jump);
      if (jump > 300) score += 1_000;
    }
    if (!best || score < best.score) best = { score, pos };
  }
  // A moving bus with no nearby part of the line going its way: we can't place it reliably.
  if (!best || (moving && best.score >= 1_000)) return null;
  return best.pos;
}

// One tracker for live data and one for demo mode.
export function makeBunchTracker() {
  const lastAlong = new Map(); // vehicleId -> meters along its route
  const seen = new Map(); // "route:bus,bus" -> { firstAt, lastAt, bunch }

  return {
    // vehicles: our usual bus list; routes: [{ id, line, isRunning }]; stoppedForMs(id)
    update(vehicles, routes, stoppedForMs) {
      const now = Date.now();
      const byRoute = new Map();
      for (const v of vehicles) {
        if (!byRoute.has(v.routeId)) byRoute.set(v.routeId, []);
        byRoute.get(v.routeId).push(v);
      }

      for (const [routeId, list] of byRoute) {
        const route = routes.find((r) => r.id === routeId);
        if (!route?.line || list.length < 2) continue;
        const shape = shapeOf(route.line);
        if (shape.length < 500) continue;

        const placed = [];
        for (const v of list) {
          if (stoppedForMs(v.id) >= PARKED_MS) continue; // layover / driver break
          const pos = placeOnLine(v, shape, lastAlong.get(v.id));
          if (pos == null) continue; // off route
          lastAlong.set(v.id, pos);
          placed.push({ v, pos });
        }
        if (placed.length < 2) continue;
        placed.sort((a, b) => a.pos - b.pos); // later in the list = further along = ahead

        // Gap from each bus to the one ahead of it.
        const n = placed.length;
        const gapAhead = (i) => {
          if (i < n - 1) return placed[i + 1].pos - placed[i].pos;
          return shape.isLoop ? shape.length - placed[i].pos + placed[0].pos : Infinity;
        };
        const even = (shape.isLoop ? shape.length : placed[n - 1].pos - placed[0].pos) / n;
        const close = (i) => {
          const gap = gapAhead(i);
          const j = (i + 1) % n;
          return gap <= BUNCH_MAX_M && gap < even * BUNCH_SHARE &&
            metersBetween(placed[i].v, placed[j].v) <= BUNCH_MAX_M;
        };

        // Walk once around, starting just after a big gap, and group runs of close neighbors.
        // (Gaps add up to the loop length, so at least one gap is big.)
        let first = 0;
        while (first < n && close((first - 1 + n) % n) && shape.isLoop) first++;
        const groups = [];
        let group = [first % n];
        for (let s = 0; s < n - 1; s++) {
          const i = (first + s) % n;
          if (close(i)) group.push((i + 1) % n);
          else { groups.push(group); group = [(i + 1) % n]; }
        }
        groups.push(group);

        for (const members of groups) {
          if (members.length < 2) continue; // members: rear bus first
          let spanM = 0;
          for (let x = 0; x < members.length - 1; x++) spanM += gapAhead(members[x]);

          // Gap behind the rear bus = how far back the NEXT bus after this bunch is.
          const rear = members[0];
          let gapBehind = null;
          if (members.length === n) {
            if (shape.isLoop) gapBehind = shape.length - spanM; // every bus is in the bunch
          } else if (shape.isLoop || rear > 0) {
            gapBehind = gapAhead((rear - 1 + n) % n);
          }

          // Only a problem for riders if there's a real hole behind the bunch.
          if (gapBehind != null && gapBehind < even) continue;

          const ids = members.map((m) => placed[m].v.id).reverse(); // front bus first
          const key = `${routeId}:${[...ids].sort((a, b) => a - b).join(',')}`;
          const entry = seen.get(key) || { firstAt: now };
          entry.lastAt = now;
          entry.bunch = {
            routeId,
            vehicleIds: ids,
            spanM: Math.round(spanM),
            gapAfterS: gapBehind == null ? null : Math.round(gapBehind / AVG_SPEED_MS),
          };
          seen.set(key, entry);
        }
      }

      for (const [key, entry] of seen) if (now - entry.lastAt > FORGET_MS) seen.delete(key);
    },

    // Bunches that have lasted long enough to show: [{ routeId, vehicleIds, spanM, gapAfterS, sinceMs }]
    current() {
      const now = Date.now();
      return [...seen.values()]
        .filter((e) => now - e.lastAt <= FORGET_MS && e.lastAt - e.firstAt >= BUNCH_MIN_MS)
        .map((e) => ({ ...e.bunch, sinceMs: e.firstAt }));
    },
  };
}
