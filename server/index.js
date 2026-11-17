// Hoos Riding server ("proxy").
// Phones ask THIS server for bus data; only this server talks to TransLoc.
// It polls TransLoc every few seconds while someone is using the app,
// keeps the latest answer in memory, and stops polling when nobody is.
// Adding ?demo=1 to any /api request replays recorded data instead (see server/demo.js).

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchVehicles, fetchRoutesAndStops, fetchArrivals, fetchCapacities } from './transloc.js';
import * as reports from './reports.js';
import * as shares from './shares.js';
import * as push from './push.js';
import * as db from './db.js';
import { makeReminders } from './reminders.js';
import * as admin from './admin.js';
import * as visitors from './visitors.js';
import * as demo from './demo.js';
import * as google from './google.js';
import { makeBunchTracker } from './bunching.js';
import { makeParkTracker } from './parked.js';
import { planTrip, estimateWalkSeconds, metersBetween } from './trips.js';

const PORT = process.env.PORT || 3001;

const VEHICLE_POLL_MS = 5_000; // how often we ask TransLoc for bus positions
const IDLE_STOP_MS = 60_000; // stop polling if no one has asked for a minute
const ROUTES_CACHE_MS = 10 * 60_000; // route list rarely changes: refresh every 10 min
const ARRIVALS_CACHE_MS = 10_000; // reuse a stop's arrival times for 10s
const CAPACITIES_POLL_MS = 15_000; // passenger counts: every 15s is plenty

if (!process.env.TRANSLOC_API_KEY) {
  console.error('Missing TRANSLOC_API_KEY. Add it to .env (see .env.example).');
  process.exit(1);
}

if (!process.env.GOOGLE_SERVER_KEY) {
  console.warn('No GOOGLE_SERVER_KEY: search and walking times are off (add it to .env).');
}

await demo.loadRecording();
await google.loadPlaces();
await google.loadSavedUsage();
await push.load();
await visitors.load();

// ---------- Vehicles (bus positions) ----------

const vehicles = { list: [], fetchedAt: 0, error: null };
const capacities = { map: new Map(), fetchedAt: 0 };
const liveMotion = reports.makeMotionTracker(); // when each bus last moved (for "broke down")
const demoMotion = reports.makeMotionTracker();
const liveBunches = makeBunchTracker(); // buses running right behind each other
const demoBunches = makeBunchTracker();
const liveParked = makeParkTracker(); // buses parked a long time (layover / driver break)
const demoParked = makeParkTracker();
let lastAskedAt = 0;
let pollTimer = null;

async function pollVehicles() {
  try {
    const needCounts = Date.now() - capacities.fetchedAt > CAPACITIES_POLL_MS;
    const [list, counts] = await Promise.all([
      fetchVehicles(),
      needCounts ? fetchCapacities().catch((err) => console.error('[capacities]', err.message)) : null,
    ]);
    if (counts) {
      capacities.map = counts;
      capacities.fetchedAt = Date.now();
    }
    // Add the live passenger count to each bus.
    vehicles.list = list.map((v) => {
      const c = capacities.map.get(v.id);
      return c ? { ...v, riders: c.riders, capacity: c.capacity } : v;
    });
    liveMotion.update(vehicles.list);
    liveParked.update(vehicles.list);
    try {
      const { list: routeList } = await getRoutes();
      liveBunches.update(vehicles.list, routeList, (id) => liveMotion.stoppedForMs(id));
    } catch (err) {
      console.error('[bunching]', err.message);
    }
    vehicles.fetchedAt = Date.now();
    vehicles.error = null;
    await updateShares(false);
  } catch (err) {
    vehicles.error = err.message;
    console.error('[vehicles]', err.message);
  }
}

function startPolling() {
  if (pollTimer) return;
  console.log('[vehicles] someone is watching: polling TransLoc every 5s');
  pollTimer = setInterval(() => {
    // Keep going while a shared ETA is still riding (its rider may have closed the app).
    if (Date.now() - lastAskedAt > IDLE_STOP_MS && !shares.riding(false).length) {
      clearInterval(pollTimer);
      pollTimer = null;
      console.log('[vehicles] nobody watching: stopped polling');
      return;
    }
    pollVehicles();
  }, VEHICLE_POLL_MS);
}

// ---------- Routes + stops (cached) ----------

const routes = { list: [], stops: [], fetchedAt: 0 };

async function getRoutes() {
  if (Date.now() - routes.fetchedAt < ROUTES_CACHE_MS && routes.list.length) return routes;
  const fresh = await fetchRoutesAndStops();
  routes.list = fresh.routes;
  routes.stops = fresh.stops;
  routes.fetchedAt = Date.now();
  return routes;
}

// ---------- Arrival times (cached per stop) ----------

const arrivalsCache = new Map(); // stopId -> { data, fetchedAt }

async function getArrivals(stopId) {
  const cached = arrivalsCache.get(stopId);
  if (cached && Date.now() - cached.fetchedAt < ARRIVALS_CACHE_MS) return cached;
  const entry = { data: await fetchArrivals(stopId), fetchedAt: Date.now() };
  arrivalsCache.set(stopId, entry);
  return entry;
}

// ---------- Web server ----------

const app = express();
app.disable('x-powered-by'); // don't advertise what software we run
app.set('trust proxy', 1); // on Render, read the phone's real address (for the speed limit)

// Is this request asking for the demo replay (and do we have one)?
const wantsDemo = (req) => 'demo' in req.query && demo.hasRecording();

// Render pings this to check the app is up. It doesn't touch TransLoc.
app.get('/api/health', (req, res) => res.json({ ok: true, demoAvailable: demo.hasRecording() }));

app.get('/api/vehicles', async (req, res) => {
  const device = req.get('X-Device'); // the phone's random ID, to mark "your" reports
  if (wantsDemo(req)) {
    const data = demo.demoVehicles();
    demoMotion.update(data.vehicles);
    demoParked.update(data.vehicles);
    demoBunches.update(data.vehicles, demo.demoRoutes().routes, (id) => demoMotion.stoppedForMs(id));
    const { routes: demoRouteList, stops: demoStops } = demo.demoRoutes();
    return res.json({ ...data, bunches: demoBunches.current(), parked: demoParked.current(demoRouteList, demoStops), reports: reports.summary({ isDemo: true, checkFor: checkerFor(true), myRawDevice: device }) });
  }

  lastAskedAt = Date.now();
  visitors.seen(device); // private user count (server/visitors.js)
  // If we haven't polled recently (first visitor after a quiet spell), get fresh data now.
  if (!pollTimer || Date.now() - vehicles.fetchedAt > VEHICLE_POLL_MS * 3) {
    await pollVehicles();
  }
  startPolling();
  res.json({
    vehicles: vehicles.list,
    fetchedAt: vehicles.fetchedAt,
    error: vehicles.error,
    bunches: liveBunches.current(),
    parked: liveParked.current(routes.list, routes.stops),
    reports: reports.summary({ isDemo: false, checkFor: checkerFor(false), myRawDevice: device }),
  });
});

// ---------- Rider reports (see server/reports.js) ----------

// Checks a report about a bus against what TransLoc says right now.
function checkerFor(isDemo) {
  const list = isDemo ? demo.demoVehicles().vehicles : vehicles.list;
  const routeList = isDemo ? demo.demoRoutes().routes : routes.list;
  const motion = isDemo ? demoMotion : liveMotion;
  const parked = isDemo ? demoParked : liveParked;
  const { routes: routeAll, stops: stopAll } = isDemo ? demo.demoRoutes() : { routes: routes.list, stops: routes.stops };
  return (vehicleId, kind) => {
    const vehicle = list.find((v) => v.id === vehicleId);
    if (!vehicle) return { result: 'unchecked' };
    const line = routeList.find((r) => r.id === vehicle.routeId)?.line;
    return reports.checkReport(kind, {
      vehicle,
      stoppedForMs: motion.stoppedForMs(vehicleId),
      parkedAtRouteStart: parked.current(routeAll, stopAll).some((p) => p.vehicleId === vehicleId && p.atRouteStart),
      distanceFromRouteM: line ? reports.distanceFromLineM(vehicle, line) : 0,
    });
  };
}

app.post('/api/reports', express.json({ limit: '2kb' }), async (req, res) => {
  const isDemo = wantsDemo(req);
  const { kind, vehicleId, stopId, device } = req.body || {};
  let target;
  if (Number.isInteger(vehicleId)) {
    if (!reports.BUS_KINDS.includes(kind)) return res.status(400).json({ error: 'Unknown report.' });
    const list = isDemo ? demo.demoVehicles().vehicles : vehicles.list;
    const bus = list.find((v) => v.id === vehicleId);
    if (!bus) return res.status(404).json({ error: 'That bus isn’t on the map anymore.' });
    target = { vehicleId, stopId: null, routeId: bus.routeId };
  } else if (Number.isInteger(stopId)) {
    if (!reports.STOP_KINDS.includes(kind)) return res.status(400).json({ error: 'Unknown report.' });
    const exists = isDemo ? demo.demoStopExists(stopId) : (await getRoutes().catch(() => routes)).stops.some((s) => s.id === stopId);
    if (!exists) return res.status(404).json({ error: 'Unknown stop.' });
    target = { vehicleId: null, stopId, routeId: null };
  } else {
    return res.status(400).json({ error: 'Report a bus or a stop.' });
  }

  const check = checkerFor(isDemo);
  const result = await reports.addReport({
    kind,
    ...target,
    rawDevice: device,
    ip: req.ip,
    isDemo,
    check: (k) => (target.vehicleId != null ? check(target.vehicleId, k) : { result: 'unchecked' }),
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error, check: result.check });
  res.json(result.report);
});

app.get('/api/routes', async (req, res) => {
  if (wantsDemo(req)) return res.json(demo.demoRoutes());
  try {
    const { list, stops } = await getRoutes();
    res.json({ routes: list, stops });
  } catch (err) {
    console.error('[routes]', err.message);
    res.status(502).json({ routes: routes.list, stops: routes.stops, error: err.message });
  }
});

app.get('/api/stops/:id/arrivals', async (req, res) => {
  const stopId = Number(req.params.id);
  if (!Number.isInteger(stopId) || stopId <= 0) {
    return res.status(400).json({ error: 'Invalid stop id' });
  }
  if (wantsDemo(req)) {
    if (!demo.demoStopExists(stopId)) return res.status(404).json({ error: 'Unknown stop' });
    return res.json(demo.demoArrivals(stopId));
  }
  try {
    // Only ask TransLoc about stops that really exist, so nobody can make our
    // server flood TransLoc with requests for made-up stops.
    const { stops } = await getRoutes();
    if (!stops.some((s) => s.id === stopId)) {
      return res.status(404).json({ error: 'Unknown stop' });
    }
    const { data, fetchedAt } = await getArrivals(stopId);
    res.json({ arrivals: data, fetchedAt });
  } catch (err) {
    console.error('[arrivals]', err.message);
    res.status(502).json({ arrivals: [], error: 'Arrival times are unavailable right now.' });
  }
});

// "Still there?" 👍 / 👎 on a report
app.post('/api/reports/:id/vote', express.json({ limit: '1kb' }), async (req, res) => {
  const { device, stillThere } = req.body || {};
  const result = await reports.vote({ reportId: req.params.id, stillThere, rawDevice: device, isDemo: wantsDemo(req) });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});

// ---------- Share my ETA (see server/shares.js) ----------

// Feed every riding share the newest bus position + its stop's arrival times.
async function updateShares(isDemo) {
  const list = shares.riding(isDemo);
  if (!list.length) return;
  const buses = isDemo ? demo.demoVehicles().vehicles : vehicles.list;
  for (const share of list) {
    let arrivals = null;
    try {
      if (isDemo) {
        const d = demo.demoArrivals(share.stop.id);
        arrivals = { data: d.arrivals, fetchedAt: d.fetchedAt };
      } else {
        arrivals = await getArrivals(share.stop.id); // cached 10s, shared with everyone
      }
    } catch (err) {
      console.error('[shares] arrivals', err.message);
    }
    shares.observe(share, buses.find((v) => v.id === share.vehicleId), arrivals);
  }
}

// { vehicleId, stopId, destName?, walkAfterS?, name?, device } → { id, token, endsAt }
app.post('/api/shares', express.json({ limit: '2kb' }), async (req, res) => {
  const isDemo = wantsDemo(req);
  const { vehicleId, stopId, destName, walkAfterS, name, device } = req.body || {};
  if (!Number.isInteger(vehicleId) || !Number.isInteger(stopId)) {
    return res.status(400).json({ error: 'Pick your bus and the stop where you get off.' });
  }
  const list = isDemo ? demo.demoVehicles().vehicles : vehicles.list;
  const vehicle = list.find((v) => v.id === vehicleId);
  if (!vehicle) return res.status(404).json({ error: 'That bus isn’t on the map anymore.' });
  const { routes: routeList, stops: stopAll } = await stopList(isDemo);
  const route = routeList.find((r) => r.id === vehicle.routeId);
  const stop = stopAll.find((s) => s.id === stopId);
  if (!route || !stop || !route.stopIds.includes(stopId)) {
    return res.status(400).json({ error: 'That stop isn’t on this bus’s route.' });
  }
  const result = shares.create({ vehicle, route, stop, destName, walkAfterS, name, rawDevice: device, ip: req.ip, isDemo });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  if (!isDemo) {
    lastAskedAt = Date.now();
    startPolling();
  }
  await updateShares(isDemo); // first ETA right away
  res.json({ id: result.share.id, token: result.share.token, endsAt: result.share.endsAt });
});

// A friend opening the link: the bus, the stop, and the live ETA.
app.get('/api/shares/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const share = shares.get(req.params.id);
  if (!share) return res.status(404).json({ error: 'This ETA link has ended.' });
  if (share.isDemo) {
    await updateShares(true);
  } else {
    lastAskedAt = Date.now();
    if (!pollTimer || Date.now() - vehicles.fetchedAt > VEHICLE_POLL_MS * 3) await pollVehicles();
    startPolling();
  }
  res.json(shares.view(share));
});

// The rider taps "Stop sharing".
app.post('/api/shares/:id/stop', express.json({ limit: '1kb' }), (req, res) => {
  if (!shares.stop(req.params.id, req.body?.token)) return res.status(403).json({ error: 'Only the phone that made this link can stop it.' });
  res.json({ ok: true });
});

// ---------- Leave-now notifications (see server/push.js) ----------

// The public key phones need to turn notifications on, and whether this phone already has them on.
app.get('/api/push/key', (req, res) => {
  res.json({ key: push.publicKey(), on: push.isOn(req.get('X-Device')) });
});

app.post('/api/push/subscribe', express.json({ limit: '4kb' }), async (req, res) => {
  const result = await push.subscribe(req.body?.device, req.body?.subscription);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', express.json({ limit: '1kb' }), async (req, res) => {
  await push.unsubscribe(req.body?.device);
  res.json({ ok: true });
});

// The phone's classes + "usually leave from" place, for leave-now reminders.
app.post('/api/push/plan', express.json({ limit: '32kb' }), async (req, res) => {
  const result = await push.setPlan(req.body?.device, req.body?.plan);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

app.post('/api/push/test', express.json({ limit: '1kb' }), async (req, res) => {
  const result = await push.sendTest(req.body?.device);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});

// ---------- Admin page (/admin, password in ADMIN_PASSWORD) ----------

app.get('/admin', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.sendFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin.html'));
});

app.post('/api/admin/login', express.json({ limit: '1kb' }), (req, res) => {
  const result = admin.login(req.body?.password, req.ip);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ token: result.token });
});

app.get('/api/admin/reports', admin.requireAdmin, async (req, res) => {
  try {
    const [list, { stops }] = await Promise.all([reports.adminList(), getRoutes().catch(() => routes)]);
    const stopNames = Object.fromEntries(stops.map((s) => [s.id, s.name]));
    const routeNames = Object.fromEntries(routes.list.map((r) => [r.id, r.name]));
    res.json({ reports: list, stopNames, routeNames });
  } catch (err) {
    console.error('[admin]', err.message);
    res.status(503).json({ error: 'Couldn’t load reports from the database.' });
  }
});

app.post('/api/admin/reports/:id/remove', admin.requireAdmin, async (req, res) => {
  try {
    await reports.adminRemove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.post('/api/admin/phones/:device/remove', admin.requireAdmin, async (req, res) => {
  try {
    await reports.adminRemovePhone(req.params.device);
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// Private user counts (server/visitors.js). Only for the logged-in owner, never on /api/usage.
app.get('/api/admin/stats', admin.requireAdmin, async (req, res) => {
  try {
    const lastTest = push.getLastTest();
    res.json({
      stats: await visitors.stats(),
      owner: visitors.ownerInfo(),
      lastTestMinAgo: lastTest ? Math.floor((Date.now() - lastTest.at) / 60_000) : null,
      usage: google.getUsage().usage,
    });
  } catch (err) {
    console.error('[admin stats]', err.message);
    res.status(500).json({ error: 'Couldn’t load the numbers (were the new tables added in Supabase?).' });
  }
});

app.post('/api/admin/owner/phone', admin.requireAdmin, async (req, res) => {
  const result = await visitors.pairPhone(push.getLastTest()).catch((err) => ({ ok: false, error: err.message }));
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/admin/owner/browser', admin.requireAdmin, express.json({ limit: '1kb' }), async (req, res) => {
  const result = await visitors.excludeBrowser(req.body?.device).catch((err) => ({ ok: false, error: err.message }));
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/admin/owner/reset', admin.requireAdmin, async (req, res) => {
  await visitors.resetOwner().catch(() => {});
  res.json({ ok: true });
});

app.post('/api/admin/owner/digest-test', admin.requireAdmin, async (req, res) => {
  try {
    const result = await visitors.sendDigestNow(push.sendTo, digestExtra());
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// For the nightly numbers: today's trip lookups + any Google cap that was hit.
function digestExtra() {
  const { usage } = google.getUsage();
  return {
    trips: usage.routes.today,
    capsHit: Object.entries(usage).filter(([, u]) => u.today >= u.dailyCap).map(([k]) => k),
  };
}

// ---------- Search + walking times (Google, through the safety layer in google.js) ----------

// Simple speed limit: each INTERNET ADDRESS gets 300 Google-backed requests per minute.
// It counts by address, not phone, and a whole classroom on UVA Wi-Fi can share one
// address (one person searching ≈ 6-8 requests), so 60 was too low for a class demo.
// Stops a bot from burning the day's caps in seconds; the daily/monthly caps in
// google.js still protect the cost.
const SPEED_LIMIT_PER_MIN = 300;
const hits = new Map(); // ip -> { count, windowStart }
function tooFast(req) {
  const now = Date.now();
  const h = hits.get(req.ip);
  if (!h || now - h.windowStart > 60_000) {
    if (hits.size > 10_000) hits.clear();
    hits.set(req.ip, { count: 1, windowStart: now });
    return false;
  }
  return ++h.count > SPEED_LIMIT_PER_MIN;
}

// Turns safety-layer errors into friendly answers for the phone.
function googleError(res, err, label) {
  if (err instanceof google.LimitReached) {
    console.warn(`[google] ${err.kind} ${err.period} cap reached`);
    return res.status(429).json({ error: err.message, limitReached: true });
  }
  console.error(`[${label}]`, err.message);
  res.status(502).json({ error: 'Search is unavailable right now.' });
}

// ---------- Bus stops in search (free: we already know every stop) ----------

// "road" and "rd" mean the same thing, etc.
const STREET_WORDS = { road: 'rd', avenue: 'ave', street: 'st', drive: 'dr', boulevard: 'blvd', lane: 'ln', circle: 'cir' };
const stopWords = (s) =>
  String(s).toLowerCase().replace(/[@&(),./-]/g, ' ').split(/\s+/).filter(Boolean).map((w) => STREET_WORDS[w] || w);

async function stopList(isDemo) {
  if (isDemo) return demo.demoRoutes();
  const r = await getRoutes().catch(() => routes);
  return { routes: r.list, stops: r.stops };
}

// Stops whose name has every typed word (as the start of a word): "univ newcomb" → University Ave @ Newcomb Rd.
async function matchStops(query, isDemo) {
  const words = stopWords(query);
  if (!words.length || query.trim().length < 3) return [];
  const { routes: routeList, stops } = await stopList(isDemo);
  const running = new Map(routeList.filter((r) => r.isRunning).map((r) => [r.id, r.name.trim()]));
  return stops
    .map((s) => ({ s, names: stopWords(s.name) }))
    .filter(({ names }) => words.every((w) => names.some((n) => n.startsWith(w))))
    .map(({ s }) => ({ s, lines: [...new Set(s.routeIds.filter((id) => running.has(id)).map((id) => running.get(id)))] }))
    .sort((a, b) => b.lines.length - a.lines.length || a.s.name.length - b.s.name.length) // running stops first
    .slice(0, 5)
    .map(({ s, lines }) => ({
      id: `stop:${s.id}`,
      name: s.name,
      detail: lines.length ? `Bus stop · ${lines.join(', ')}` : 'Bus stop · no buses right now',
      source: 'stop',
    }));
}

app.get('/api/search', async (req, res) => {
  if (tooFast(req)) return res.status(429).json({ error: 'Slow down a little!' });
  try {
    const q = String(req.query.q || '');
    const stops = await matchStops(q, wantsDemo(req));
    // Typing a stop name ("@", or 2+ matching stops): stops answer it, so skip Google (saves calls).
    const allowGoogle = !(q.includes('@') || stops.length >= 2);
    const result = await google.search(q, req.query.session, { allowGoogle });
    const uva = result.suggestions.filter((s) => s.source === 'uva');
    const other = result.suggestions.filter((s) => s.source !== 'uva');
    res.json({ ...result, suggestions: [...uva, ...stops, ...other].slice(0, 8) });
  } catch (err) {
    googleError(res, err, 'search');
  }
});

// SIS schedule import: match building names to our UVA places list (free, no Google).
// /api/buildings?names=Rouss Hall|Cobb Hall  →  { matches: { "Rouss Hall": {…place} | null } }
app.get('/api/buildings', (req, res) => {
  const names = String(req.query.names || '').split('|').map((n) => n.trim()).filter(Boolean).slice(0, 30);
  const matches = Object.fromEntries(names.map((n) => [n, google.matchBuilding(n)]));
  res.json({ matches });
});

app.get('/api/places/:id', async (req, res) => {
  if (tooFast(req)) return res.status(429).json({ error: 'Slow down a little!' });
  const stopMatch = /^stop:(\d+)$/.exec(req.params.id);
  if (stopMatch) {
    const { stops } = await stopList(wantsDemo(req));
    const s = stops.find((x) => x.id === Number(stopMatch[1]));
    if (!s) return res.status(404).json({ error: 'Stop not found' });
    return res.json({ id: req.params.id, stopId: s.id, name: s.name, address: 'UVA bus stop', location: { lat: s.lat, lng: s.lng }, source: 'stop' });
  }
  try {
    const place = await google.getPlace(req.params.id, req.query.session);
    if (!place) return res.status(404).json({ error: 'Place not found' });
    res.json(place);
  } catch (err) {
    googleError(res, err, 'place');
  }
});

// "38.03,-78.50" -> { lat: 38.03, lng: -78.50 }
const parsePoint = (s) => {
  const [lat, lng] = String(s || '').split(',').map(Number);
  return { lat, lng };
};

// /api/walk?from=38.03,-78.50&to=38.04,-78.51
app.get('/api/walk', async (req, res) => {
  if (tooFast(req)) return res.status(429).json({ error: 'Slow down a little!' });
  try {
    const walk = await google.getWalk(parsePoint(req.query.from), parsePoint(req.query.to));
    if (!walk) return res.status(400).json({ error: 'Those points are not near UVA.' });
    res.json(walk);
  } catch (err) {
    googleError(res, err, 'walk');
  }
});

// Trip options: walk + wait + ride + walk, compared with walking the whole way.
// /api/trip?from=38.03,-78.50&to=38.04,-78.51  (add &demo=1 for the recorded buses)
const GROUNDS = { lat: 38.0336, lng: -78.508 };
const TRIP_RADIUS_M = 8_000; // both ends must be within ~5 miles of Grounds

app.get('/api/trip', async (req, res) => {
  if (tooFast(req)) return res.status(429).json({ error: 'Slow down a little!' });
  const from = parsePoint(req.query.from);
  const to = parsePoint(req.query.to);
  const valid = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng);
  if (!valid(from) || !valid(to)) return res.status(400).json({ error: 'Missing start or destination.' });
  if (metersBetween(from, GROUNDS) > TRIP_RADIUS_M || metersBetween(to, GROUNDS) > TRIP_RADIUS_M) {
    return res.status(400).json({ error: 'That trip is too far from Grounds.', farAway: true });
  }
  // Optional "arrive by" time (ms since 1970), within the next 24 hours.
  let arriveByMs;
  if (req.query.arriveBy) {
    arriveByMs = Number(req.query.arriveBy);
    if (!Number.isFinite(arriveByMs) || arriveByMs < Date.now() - 60_000 || arriveByMs > Date.now() + 24 * 3600_000) {
      return res.status(400).json({ error: 'Pick an arrival time within the next 24 hours.' });
    }
  }

  try {
    const prefer = ['fastest', 'walk', 'transfers'].includes(req.query.prefer) ? req.query.prefer : 'fastest';
    res.json(await computeTrip({ from, to, arriveByMs, prefer, isDemo: wantsDemo(req), quick: req.query.quick === '1' }));
  } catch (err) {
    console.error('[trip]', err.message);
    res.status(502).json({ error: 'Trip times are unavailable right now.' });
  }
});

// Trip options from a to b (also used by leave-now reminders, server/reminders.js).
// quick: skip CAT + transfers (catStatus 'later'), so the phone can show walk + UVA first
// while the full answer (asked at the same time) waits for Google's CAT times.
async function computeTrip({ from, to, arriveByMs, prefer = 'fastest', isDemo = false, quick = false }) {
  // The whole-way walking time is the only Google call (cached). Falls back to a free estimate.
  const getDirectWalk = async () => {
    try {
      const walk = await google.getWalk(from, to);
      if (walk) return { seconds: walk.seconds, estimated: false, polyline: walk.polyline };
    } catch (err) {
      if (!(err instanceof google.LimitReached)) console.error('[trip] walk', err.message);
    }
    return { seconds: estimateWalkSeconds(from, to), estimated: true };
  };

  // CAT city buses from Google's schedules (cached 5 min). UVA + walking still work if this fails.
  // Also used for transfers: CAT between other points (a, b), leaving later (leaveAtMs).
  const getCat = async (a = from, b = to, leaveAtMs, arriveByMs) => {
    if (quick) return { options: [], status: 'later' };
    try {
      return { options: await google.getTransit(a, b, leaveAtMs, arriveByMs), status: 'ok' };
    } catch (err) {
      if (err instanceof google.LimitReached) return { options: [], status: 'limit' };
      console.error('[trip] cat', err.message);
      return { options: [], status: 'error' };
    }
  };

  let routesList, stopsList, arrivalsFor;
  if (isDemo) {
    ({ routes: routesList, stops: stopsList } = demo.demoRoutes());
    arrivalsFor = async (id) => {
      const d = demo.demoArrivals(id);
      return { data: d.arrivals, fetchedAt: d.fetchedAt };
    };
  } else {
    ({ list: routesList, stops: stopsList } = await getRoutes());
    arrivalsFor = getArrivals;
  }
  return planTrip({ from, to, routes: routesList, stops: stopsList, getArrivals: arrivalsFor, getDirectWalk, getCat, arriveByMs, prefer });
}

// Leave-now reminders: checks every minute (server/reminders.js).
const reminders = makeReminders({
  entries: push.entries,
  send: push.sendTo,
  planTrip: ({ from, to, arriveByMs }) => computeTrip({ from, to, arriveByMs }),
  metersBetween,
  claim: (device, classId, day) => (db.configured ? db.claimReminder(device, classId, day) : true),
});
// Forget "already sent" notes older than 2 days (checked every 6 h).
if (db.configured) {
  setInterval(() => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    db.deleteReminderSendsBefore(twoDaysAgo).catch(() => {});
  }, 6 * 3600_000).unref();
}
if (push.configured) reminders.start();
if (push.configured) visitors.startDigest({ send: push.sendTo, extra: digestExtra });

// How much of our Google allowance we've used. Safe to show: no keys or personal data.
app.get('/api/usage', (req, res) => res.json({ ...google.getUsage(), reminders: reminders.status() }));

// In production, this same server also hands out the built website (the dist folder).
const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
app.use(express.static(distDir));

app.listen(PORT, () => {
  console.log(`Hoos Riding server running at http://localhost:${PORT}`);
});
