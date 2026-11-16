// "Share my ETA": a link friends can open to watch the bus you're on reach your stop.
//
// Privacy: we never get the rider's GPS. A share is only: which bus, which stop you get off at,
// where you're walking after (a place name), and an optional first name.
// Kept in server memory only (a restart or redeploy ends open links, which is fine for short trips).
// A link ends 15 min after the bus reaches the stop, or 2 hours after it was made, whichever is first.
//
// server/index.js feeds every share the latest bus positions and arrival times (observe()),
// and keeps polling TransLoc while a share is still riding, even if nobody has the app open.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { scrambleDevice } from './reports.js';
import { metersBetween } from './trips.js';

const AFTER_ARRIVAL_MS = 15 * 60_000; // link stays up this long after the bus reaches the stop
const MAX_LIFE_MS = 2 * 60 * 60_000; // and never longer than this
const LOST_MS = 3 * 60_000; // bus missing from TransLoc this long: stop following it
const AT_STOP_M = 60; // bus this close to the stop (and due) = arrived
const DUE_S = 180; // "due" = TransLoc said it was under 3 min away
const MAX_ACTIVE = 300; // safety limit for memory
const LIMIT_PER_DEVICE = 5; // links per phone...
const LIMIT_PER_ADDRESS = 20; // ...and per internet address...
const LIMIT_WINDOW_MS = 60 * 60_000; // ...per hour

const shares = new Map(); // id -> share
const recent = new Map(); // "device:…" / "ip:…" -> [timestamps]

function overLimit(key, max) {
  const now = Date.now();
  const list = (recent.get(key) || []).filter((t) => now - t < LIMIT_WINDOW_MS);
  recent.set(key, list);
  return list.length >= max;
}

// Short, hard-to-guess link ID ("k3J9xQ2mPa") and a secret "stop sharing" token for the rider.
const randomId = (bytes) => randomBytes(bytes).toString('base64url');

// Names and place names are shown to other people: keep them short and plain.
function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Make a new share. vehicle/route/stop are already checked by index.js (the bus is live,
 * the stop is on its route). Returns { ok: true, share } or { ok: false, status, error }.
 */
export function create({ vehicle, route, stop, destName, walkAfterS, name, rawDevice, ip, isDemo }) {
  const now = Date.now();
  if (metersBetween(vehicle, stop) <= AT_STOP_M) {
    return { ok: false, status: 400, error: 'The bus is at that stop right now. Pick the stop where you’ll get off.' };
  }
  const deviceKey = `device:${scrambleDevice(rawDevice || ip)}`;
  const ipKey = `ip:${ip}`;
  if (overLimit(deviceKey, LIMIT_PER_DEVICE) || overLimit(ipKey, LIMIT_PER_ADDRESS)) {
    return { ok: false, status: 429, error: 'You’ve made a lot of links this hour. Try again later.' };
  }
  cleanUp();
  if (shares.size >= MAX_ACTIVE) return { ok: false, status: 503, error: 'Too many shared trips right now. Try again soon.' };
  for (const key of [deviceKey, ipKey]) recent.set(key, [...(recent.get(key) || []), now]);

  const walk = Number(walkAfterS);
  const share = {
    id: randomId(8),
    token: randomId(18),
    isDemo,
    createdAt: now,
    endsAt: now + MAX_LIFE_MS,
    vehicleId: vehicle.id,
    busName: vehicle.name,
    route: { id: route.id, name: route.name, color: route.color },
    stop: { id: stop.id, name: stop.name, lat: stop.lat, lng: stop.lng },
    destName: cleanText(destName, 60) || null,
    walkAfterS: Number.isFinite(walk) ? Math.round(Math.min(Math.max(walk, 0), 30 * 60)) : 0,
    name: cleanText(name, 20) || null,
    status: 'riding', // riding → arrived | lost
    etaS: null, // seconds until the bus reaches the stop, as of etaAt
    etaAt: null,
    arrivedAt: null,
    lastSeenAt: now,
    bus: { lat: vehicle.lat, lng: vehicle.lng },
  };
  shares.set(share.id, share);
  return { ok: true, share };
}

/**
 * Update a share with the newest data.
 * vehicle: this bus from the latest TransLoc poll (or undefined if it's missing).
 * arrivals: { data, fetchedAt } for the share's stop (or null if unavailable).
 */
export function observe(share, vehicle, arrivals, now = Date.now()) {
  if (share.status !== 'riding') return;

  if (vehicle) {
    share.bus = { lat: vehicle.lat, lng: vehicle.lng };
    share.lastSeenAt = now;
  } else if (now - share.lastSeenAt > LOST_MS) {
    share.status = 'lost';
    share.endsAt = Math.min(share.endsAt, now + AFTER_ARRIVAL_MS);
    return;
  }

  // TransLoc's countdown for THIS bus at the stop.
  let eta = null;
  if (arrivals?.data) {
    const ageS = (now - arrivals.fetchedAt) / 1000;
    for (const a of arrivals.data) {
      for (const t of a.times || []) {
        if (t.vehicleId !== share.vehicleId) continue;
        const s = Math.max(0, t.seconds - ageS);
        if (eta === null || s < eta) eta = s;
      }
    }
  }

  // What the countdown should say now, from the last one we saw.
  const expected = share.etaS === null ? null : share.etaS - (now - share.etaAt) / 1000;
  const wasDue = expected !== null && expected <= DUE_S;
  // At the stop: close by AND due (a loop can pass near the stop earlier, on the other side of the street).
  // If TransLoc never gave this bus a time here, being close is all we have.
  const neverTimed = share.etaS === null && eta === null;
  const atStop = vehicle && metersBetween(vehicle, share.stop) <= AT_STOP_M && (wasDue || neverTimed || (eta !== null && eta <= DUE_S));
  // Passed it: was due, then the countdown vanished or jumped to the next loop.
  const passed = wasDue && (eta === null || eta > expected + 5 * 60);

  if (atStop || passed) {
    share.status = 'arrived';
    share.arrivedAt = now;
    share.etaS = 0;
    share.etaAt = now;
    share.endsAt = Math.min(share.endsAt, now + AFTER_ARRIVAL_MS);
    return;
  }
  if (eta !== null) {
    share.etaS = eta;
    share.etaAt = now;
  }
}

// A share that's still open, or null (unknown, ended, or stopped by the rider).
export function get(id) {
  const share = shares.get(String(id));
  if (!share || Date.now() > share.endsAt) return null;
  return share;
}

// What a friend's phone sees. Never the token.
export function view(share, now = Date.now()) {
  const etaSeconds = share.etaS === null ? null : Math.max(0, Math.round(share.etaS - (now - share.etaAt) / 1000));
  return {
    id: share.id,
    name: share.name,
    route: share.route,
    vehicleId: share.vehicleId,
    busName: share.busName,
    stop: share.stop,
    destName: share.destName,
    walkAfterS: share.walkAfterS,
    status: share.status,
    etaSeconds: share.status === 'riding' ? etaSeconds : null,
    arrivedAt: share.arrivedAt,
    endsAt: share.endsAt,
    bus: share.bus,
    serverNow: now,
  };
}

// "Stop sharing": only the phone that made the link has the token.
export function stop(id, token) {
  const share = shares.get(String(id));
  if (!share) return true;
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(share.token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  shares.delete(share.id);
  return true;
}

// Shares still waiting for their bus (index.js feeds these and keeps polling for them).
export const riding = (isDemo) =>
  [...shares.values()].filter((s) => s.isDemo === isDemo && s.status === 'riding' && Date.now() <= s.endsAt);

function cleanUp() {
  const now = Date.now();
  for (const [id, s] of shares) if (now > s.endsAt) shares.delete(id);
  for (const [k, list] of recent) if (!list.some((t) => now - t < LIMIT_WINDOW_MS)) recent.delete(k);
}
setInterval(cleanUp, 5 * 60_000).unref();
