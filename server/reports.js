// Rider reports (Waze-style): "Packed", "Broke down", "Skipped stop"...
//
// - Phones send reports to OUR server (never to Supabase). We check limits first.
// - No logins and no locations: each phone has a random ID, which we scramble (hash)
//   before saving. We only store WHICH bus or stop a report is about.
// - Reports expire after 15 minutes. "Still there? 👍" pushes that to 10 min after the answer
//   (at most 45 min after the first report). Two "👎 not anymore" (and no more 👍 than 👎) hide it.
// - Where TransLoc's live data can check a report, it does (see checkReport):
//     packed / seats open  → real passenger count
//     broke down           → is the bus moving, or stopped for minutes?
//     detour               → is the bus off its route?
//   A report the live data clearly contradicts is refused, and an old one stops showing.
// - Live reports are kept in memory and re-read from Supabase every 15s, so phones asking
//   every few seconds never touch the database. Demo mode (?demo) keeps its reports in
//   memory only, so demos never leave fake reports on real buses.

import { createHash } from 'node:crypto';
import * as db from './db.js';

const EXPIRE_MS = 15 * 60_000;
const RELOAD_MS = 15_000;
const LIMIT_PER_DEVICE = 5; // reports per phone...
const LIMIT_PER_ADDRESS = 60; // ...and per internet address (a whole class can share one Wi-Fi address)...
const LIMIT_WINDOW_MS = 10 * 60_000; // ...per 10 minutes
const VOTE_LIMIT_PER_DEVICE = 20; // "still there?" answers per phone per 10 minutes
const STILL_THERE_ADDS_MS = 10 * 60_000;
const MAX_LIFE_MS = 45 * 60_000;
const HIDE_AT_DOWNS = 2;
const KEEP_DAYS = 30; // delete reports older than this from the database

export const BUS_KINDS = ['packed', 'seats_open', 'broke_down', 'detour', 'ramp_broken'];
export const STOP_KINDS = ['skipped_stop', 'detour'];

// Passenger count thresholds (share of the bus's capacity).
const PACKED_AT = 0.6; // "packed" is believable from 60% full
const NOT_PACKED_BELOW = 0.3; // ...and clearly wrong under 30%
const SEATS_GONE_AT = 0.9; // "seats open" is clearly wrong from 90% full
const SEATS_OPEN_BELOW = 0.7;
const MOVING_MPH = 3;
const BROKEN_AFTER_MS = 3 * 60_000; // stopped this long supports "broke down"
const OFF_ROUTE_M = 150; // this far from its route line supports "detour"

// ---------- Storage ----------

const stores = {
  live: { list: [], loadedAt: 0 },
  demo: { list: [], loadedAt: Date.now() },
};
let nextDemoId = 1;

async function reload() {
  if (!db.configured) return;
  try {
    const rows = await db.loadLiveReports();
    stores.live.list = rows.map(fromRow); // the database is the truth (e.g. admin removals)
    stores.live.loadedAt = Date.now();
  } catch (err) {
    console.error('[reports] could not load from Supabase:', err.message);
  }
}

const fromRow = (r) => ({
  id: r.id,
  kind: r.kind,
  routeId: r.route_id,
  vehicleId: r.vehicle_id,
  stopId: r.stop_id,
  device: r.device,
  createdAt: Date.parse(r.created_at),
  expiresAt: Date.parse(r.expires_at),
  votes: new Map((r.report_votes || []).map((v) => [v.device, v.still_there])), // device -> true/false
});

async function cleanUp() {
  try {
    await db.deleteReportsBefore(new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60_000).toISOString());
  } catch (err) {
    console.error('[reports] clean-up failed:', err.message);
  }
}

if (db.configured) {
  reload();
  setInterval(reload, RELOAD_MS).unref();
  cleanUp();
  setInterval(cleanUp, 24 * 60 * 60_000).unref();
}

export const reloadNow = reload; // after the admin removes something

function liveList(isDemo) {
  const store = isDemo ? stores.demo : stores.live;
  const now = Date.now();
  store.list = store.list.filter((r) => r.expiresAt > now);
  return store.list;
}

// ---------- Anonymous phone IDs + limits ----------

// The same phone always gives the same scrambled ID, but it can't be turned back into the original.
const SALT = `hoos-riding-reports|${process.env.SUPABASE_SECRET_KEY || 'local'}`;
export function scrambleDevice(raw) {
  return createHash('sha256').update(`${SALT}|${raw}`).digest('hex').slice(0, 32);
}

const recent = new Map(); // "device:abc" / "ip:1.2.3.4" -> [timestamps]
function overLimit(key, max) {
  const now = Date.now();
  const list = (recent.get(key) || []).filter((t) => now - t < LIMIT_WINDOW_MS);
  recent.set(key, list);
  return list.length >= max;
}
function noteUse(key) {
  recent.get(key).push(Date.now());
}
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of recent) if (!list.some((t) => now - t < LIMIT_WINDOW_MS)) recent.delete(k);
}, LIMIT_WINDOW_MS).unref();

// ---------- Is the bus moving? (for "broke down") ----------

// Remembers when each bus last moved. Fed with every vehicle list we get (live and demo).
export function makeMotionTracker() {
  const lastMoved = new Map();
  return {
    update(vehicles) {
      const now = Date.now();
      for (const v of vehicles) {
        if (!lastMoved.has(v.id) || v.speed > MOVING_MPH) lastMoved.set(v.id, now);
      }
    },
    stoppedForMs(id) {
      return lastMoved.has(id) ? Date.now() - lastMoved.get(id) : 0;
    },
  };
}

// ---------- Checking a report against live data ----------

// Returns { result: 'supported' | 'conflict' | 'unchecked', note }
// ctx: { vehicle, stoppedForMs, distanceFromRouteM, parkedAtRouteStart }
export function checkReport(kind, ctx) {
  const v = ctx.vehicle;
  if (!v) return { result: 'unchecked' };
  const share = v.capacity > 0 && v.riders !== undefined ? v.riders / v.capacity : null;
  // A count of exactly 0 may mean the bus's counter is off, so don't judge on it.
  const counted = share !== null && v.riders > 0;
  const count = counted ? `${v.riders} of ${v.capacity} riders` : '';

  if (kind === 'packed' && counted) {
    if (share >= PACKED_AT) return { result: 'supported', note: `Live count: ${count}` };
    if (share < NOT_PACKED_BELOW) return { result: 'conflict', note: `The bus's live count shows only ${count}.` };
  }
  if (kind === 'seats_open' && counted) {
    if (share < SEATS_OPEN_BELOW) return { result: 'supported', note: `Live count: ${count}` };
    if (share >= SEATS_GONE_AT) return { result: 'conflict', note: `The bus's live count shows ${count}.` };
  }
  if (kind === 'broke_down') {
    if (v.speed > MOVING_MPH) return { result: 'conflict', note: 'This bus is moving normally right now.' };
    // Parked where its route starts = almost surely a layover / driver break, not a breakdown.
    if (ctx.parkedAtRouteStart) return { result: 'unchecked' };
    if (ctx.stoppedForMs >= BROKEN_AFTER_MS) {
      return { result: 'supported', note: `Not moving for ${Math.round(ctx.stoppedForMs / 60_000)} min` };
    }
  }
  if (kind === 'detour' && (v.onRoute === false || ctx.distanceFromRouteM > OFF_ROUTE_M)) {
    return { result: 'supported', note: 'The bus is off its usual route' };
  }
  return { result: 'unchecked' };
}

// ---------- How far is a bus from its route line? (for "detour") ----------

const decodedLines = new Map(); // encoded line -> [{ lat, lng }]

// Google's "encoded polyline" format → points (same format TransLoc uses for route lines).
export function decodeLine(encoded) {
  if (decodedLines.has(encoded)) return decodedLines.get(encoded);
  const points = [];
  let i = 0, lat = 0, lng = 0;
  while (i < encoded.length) {
    for (const axis of ['lat', 'lng']) {
      let result = 0, shift = 0, b;
      do {
        b = encoded.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 'lat') lat += delta; else lng += delta;
    }
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  if (decodedLines.size > 100) decodedLines.clear();
  decodedLines.set(encoded, points);
  return points;
}

// Shortest distance in meters from a point to the line (flat-earth math: fine at city scale).
export function distanceFromLineM(point, encoded) {
  const pts = decodeLine(encoded);
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos((point.lat * Math.PI) / 180);
  const xy = (p) => ({ x: (p.lng - point.lng) * mPerLng, y: (p.lat - point.lat) * mPerLat }); // point at (0,0)
  let best = Infinity;
  for (let k = 1; k < pts.length; k++) {
    const a = xy(pts[k - 1]), b = xy(pts[k]);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
  }
  return best;
}

// ---------- Adding a report ----------

// Returns { ok: true, report } or { ok: false, status, error }
export async function addReport({ kind, vehicleId, stopId, routeId, rawDevice, ip, isDemo, check }) {
  if (typeof rawDevice !== 'string' || rawDevice.length < 8 || rawDevice.length > 100) {
    return { ok: false, status: 400, error: 'Missing phone ID.' };
  }
  const device = scrambleDevice(rawDevice);
  const list = liveList(isDemo);

  if (list.some((r) => r.device === device && r.kind === kind && r.vehicleId === vehicleId && r.stopId === stopId)) {
    return { ok: false, status: 409, error: 'You already reported this. Thanks!' };
  }
  const deviceKey = `device:${device}`;
  const ipKey = `ip:${ip}`;
  if (overLimit(deviceKey, LIMIT_PER_DEVICE) || overLimit(ipKey, LIMIT_PER_ADDRESS)) {
    return { ok: false, status: 429, error: 'That’s a lot of reports! Try again in a few minutes.' };
  }

  const verdict = check(kind);
  if (verdict.result === 'conflict') {
    return { ok: false, status: 422, error: `Thanks, but we didn’t post this one: ${verdict.note}`, check: verdict };
  }

  noteUse(deviceKey);
  noteUse(ipKey);
  const now = Date.now();
  const report = { kind, vehicleId, stopId, routeId, device, createdAt: now, expiresAt: now + EXPIRE_MS, votes: new Map() };

  if (isDemo || !db.configured) {
    report.id = `m${nextDemoId++}`; // memory only
  } else {
    try {
      const [row] = await db.insertReport({
        kind,
        vehicle_id: vehicleId,
        stop_id: stopId,
        route_id: routeId,
        device,
        expires_at: new Date(report.expiresAt).toISOString(),
      });
      report.id = row.id;
      report.createdAt = Date.parse(row.created_at);
    } catch (err) {
      console.error('[reports] could not save:', err.message);
      return { ok: false, status: 503, error: 'Reports are unavailable right now. Try again soon.' };
    }
  }
  list.push(report);
  return { ok: true, report: { kind, check: verdict } };
}

// ---------- What phones see ----------

// Groups live reports: { buses: { [vehicleId]: [group] }, stops: { [stopId]: [group] } }
// group = { kind, riders (how many phones), newestAt, check }
// Reports the live data now contradicts are left out (e.g. "packed" after the bus emptied).
export function summary({ isDemo, checkFor, myRawDevice }) {
  const mine = myRawDevice ? scrambleDevice(myRawDevice) : null;
  const groups = new Map();
  for (const r of liveList(isDemo)) {
    const key = r.vehicleId != null ? `b${r.vehicleId}:${r.kind}` : `s${r.stopId}:${r.kind}`;
    const g = groups.get(key) || { r, kind: r.kind, devices: new Set(), newestAt: 0, votes: new Map() };
    g.devices.add(r.device);
    if (r.createdAt >= g.newestAt) {
      g.newestAt = r.createdAt;
      g.newestId = r.id;
    }
    for (const [d, up] of r.votes || []) g.votes.set(d, up);
    groups.set(key, g);
  }
  const out = { buses: {}, stops: {} };
  for (const g of groups.values()) {
    const check = g.r.vehicleId != null ? checkFor(g.r.vehicleId, g.kind) : { result: 'unchecked' };
    if (check.result === 'conflict') continue;
    const ups = [...g.votes.values()].filter(Boolean).length;
    const downs = g.votes.size - ups;
    if (downs >= HIDE_AT_DOWNS && downs >= ups) continue; // riders say it's over
    const item = {
      id: g.newestId, // vote on this one
      kind: g.kind,
      riders: g.devices.size,
      newestAt: g.newestAt,
      ups,
      downs,
      check,
      mine: mine ? g.devices.has(mine) : false,
      myVote: mine && g.votes.has(mine) ? g.votes.get(mine) : null,
    };
    const [bucket, id] = g.r.vehicleId != null ? ['buses', g.r.vehicleId] : ['stops', g.r.stopId];
    (out[bucket][id] ||= []).push(item);
  }
  return out;
}

// ---------- "Still there?" ----------

// Returns { ok: true } or { ok: false, status, error }
export async function vote({ reportId, stillThere, rawDevice, isDemo }) {
  if (typeof rawDevice !== 'string' || rawDevice.length < 8 || rawDevice.length > 100) {
    return { ok: false, status: 400, error: 'Missing phone ID.' };
  }
  if (typeof stillThere !== 'boolean') return { ok: false, status: 400, error: 'Say yes or no.' };
  const device = scrambleDevice(rawDevice);
  const list = liveList(isDemo);
  const report = list.find((r) => String(r.id) === String(reportId));
  if (!report) return { ok: false, status: 404, error: 'That report already expired.' };

  // Every live report of the same kind about the same bus/stop counts as one.
  const group = list.filter((r) => r.kind === report.kind && r.vehicleId === report.vehicleId && r.stopId === report.stopId);
  if (group.some((r) => r.device === device)) {
    return { ok: false, status: 403, error: 'That’s your own report. Other riders can confirm it.' };
  }
  const key = `vote:${device}`;
  if (overLimit(key, VOTE_LIMIT_PER_DEVICE)) return { ok: false, status: 429, error: 'Too many answers. Try again in a few minutes.' };

  const now = Date.now();
  let expiresAt = report.expiresAt;
  if (stillThere) {
    const first = Math.min(...group.map((r) => r.createdAt));
    expiresAt = Math.max(report.expiresAt, Math.min(now + STILL_THERE_ADDS_MS, first + MAX_LIFE_MS));
  }

  if (!isDemo && db.configured) {
    try {
      await db.saveVote(report.id, device, stillThere);
      if (expiresAt !== report.expiresAt) await db.setReportExpiry(report.id, new Date(expiresAt).toISOString());
    } catch (err) {
      console.error('[reports] could not save vote:', err.message);
      return { ok: false, status: 503, error: 'Couldn’t save that. Try again soon.' };
    }
  }
  noteUse(key);
  for (const r of group) r.votes?.delete(device); // one answer per phone for the whole group
  report.votes ||= new Map();
  report.votes.set(device, stillThere);
  report.expiresAt = expiresAt;
  return { ok: true };
}

// ---------- Admin page ----------

export async function adminList() {
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const rows = await db.loadRecentReports(since);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    routeId: r.route_id,
    vehicleId: r.vehicle_id,
    stopId: r.stop_id,
    phone: r.device, // already scrambled
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    removed: r.removed,
    ups: (r.report_votes || []).filter((v) => v.still_there).length,
    downs: (r.report_votes || []).filter((v) => !v.still_there).length,
  }));
}

export async function adminRemove(id) {
  await db.removeReportById(id);
  await reload();
}

export async function adminRemovePhone(device) {
  await db.removeReportsByDevice(device, new Date(Date.now() - 24 * 60 * 60_000).toISOString());
  await reload();
}
