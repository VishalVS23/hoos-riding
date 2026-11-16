// The ONLY place in the app that talks to Google Places and Routes.
// Every call passes through three protections:
//   1. Daily + monthly caps (Google won't let us set our own quotas, so we do it here).
//   2. A cache: the same question asked again reuses the saved answer for free.
//   3. Our UVA nickname list (places.json) is checked first, so "O-Hill" costs nothing.
// Counters are kept in memory and saved to Supabase every 30s (server/db.js), so the caps
// survive restarts and Render sleeping. Without Supabase they reset on restart, like before.

import { readFile } from 'node:fs/promises';
import * as db from './db.js';

const KEY = process.env.GOOGLE_SERVER_KEY;

// Center of Grounds: used to bias searches toward Charlottesville.
const GROUNDS = { latitude: 38.0336, longitude: -78.508 };
const SEARCH_RADIUS_M = 20_000; // ~12 miles: covers Charlottesville + the airport
const MAX_TRIP_KM = 40; // refuse route requests that are nowhere near UVA

// ---------- 1. Caps ----------

export const CAPS = {
  autocomplete: { day: 1_000, month: 9_000 },
  placeDetails: { day: 300, month: 9_000 },
  routes: { day: 600, month: 9_000 },
};

// Use Charlottesville's calendar so "today" resets at local midnight.
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // "2026-11-12"

const usage = {};
for (const kind of Object.keys(CAPS)) usage[kind] = { day: 0, month: 0, dayKey: '', monthKey: '' };

function rollOver(u) {
  const d = today();
  if (u.dayKey !== d) { u.dayKey = d; u.day = 0; }
  if (u.monthKey !== d.slice(0, 7)) { u.monthKey = d.slice(0, 7); u.month = 0; }
}

// A friendly error the routes can show instead of calling Google.
export class LimitReached extends Error {
  constructor(kind, period) {
    super(`Search is resting for ${period === 'day' ? 'today' : 'this month'}. Try again later!`);
    this.kind = kind;
    this.period = period;
  }
}

// Call this right BEFORE asking Google. Throws if we're at the cap.
function spend(kind) {
  const u = usage[kind];
  rollOver(u);
  if (u.day >= CAPS[kind].day) throw new LimitReached(kind, 'day');
  if (u.month >= CAPS[kind].month) throw new LimitReached(kind, 'month');
  u.day++;
  u.month++;
  db.addGoogleUsage(kind, [u.dayKey, u.monthKey]);
}

// At startup: add back what was already used today / this month (saved in Supabase).
export async function loadSavedUsage() {
  if (!db.configured) return;
  const d = today();
  try {
    const rows = await db.loadGoogleUsage([d, d.slice(0, 7)]);
    for (const row of rows) {
      const u = usage[row.kind];
      if (!u) continue;
      rollOver(u);
      if (row.period === u.dayKey) u.day += row.count;
      else if (row.period === u.monthKey) u.month += row.count;
    }
    console.log('[google] usage loaded from Supabase');
  } catch (err) {
    console.error('[google] could not load saved usage (counting from 0):', err.message);
  }
}

export function getUsage() {
  const out = {};
  for (const [kind, u] of Object.entries(usage)) {
    rollOver(u);
    out[kind] = { today: u.day, dailyCap: CAPS[kind].day, thisMonth: u.month, monthlyCap: CAPS[kind].month };
  }
  return { date: today(), keyConfigured: Boolean(KEY), database: db.status(), usage: out, cached: { searches: searchCache.size, places: placeCache.size, routes: routeCache.size, cat: transitCache.size } };
}

// ---------- 2. Cache ----------

// A simple "remember answers for a while" store that never grows too big.
class TimedCache extends Map {
  constructor(ttlMs, maxEntries = 2_000) { super(); this.ttlMs = ttlMs; this.maxEntries = maxEntries; }
  read(key) {
    const hit = super.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) { this.delete(key); return undefined; }
    return hit.value;
  }
  write(key, value) {
    if (this.size >= this.maxEntries) this.delete(this.keys().next().value); // drop the oldest
    this.set(key, { value, at: Date.now() });
  }
}

const DAY = 24 * 60 * 60_000;
const searchCache = new TimedCache(DAY);
const placeCache = new TimedCache(30 * DAY, 5_000);
const routeCache = new TimedCache(DAY);

// ---------- 3. UVA nickname list ----------

let uvaPlaces = [];

// "O-Hill", "o hill", "The O Hill" all become "ohill".
export const normalize = (s) => String(s).toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');

export async function loadPlaces() {
  const file = new URL('./places.json', import.meta.url);
  uvaPlaces = JSON.parse(await readFile(file, 'utf8')).places.map((p) => ({
    ...p,
    keys: [p.name, ...p.aliases].map(normalize),
  }));
  const missing = uvaPlaces.filter((p) => !p.location).length;
  console.log(`[google] loaded ${uvaPlaces.length} UVA places${missing ? ` (${missing} missing a location: run npm run places)` : ''}`);
}

const asSuggestion = (p) => ({ id: `uva:${p.id}`, name: p.name, detail: p.address || 'UVA', source: 'uva' });

// Returns { exact, partial } UVA places matching what the user typed.
function matchUva(input) {
  const q = normalize(input);
  if (!q) return { exact: [], partial: [] };
  const usable = uvaPlaces.filter((p) => p.location);
  const exact = usable.filter((p) => p.keys.includes(q));
  const partial = q.length < 2 ? [] : usable.filter((p) => !exact.includes(p) && p.keys.some((k) => k.startsWith(q) || (q.length >= 4 && k.includes(q))));
  return { exact, partial };
}

// For the SIS schedule import: "Rouss Hall" → our UVA place, or null. Never calls Google.
// Also accepts a place's name without its "(…)" part, e.g. "Thornton Hall".
export function matchBuilding(name) {
  const q = normalize(name);
  if (!q) return null;
  const usable = uvaPlaces.filter((p) => p.location);
  const hit = usable.find((p) => p.keys.includes(q)) ||
    usable.find((p) => normalize(p.name.replace(/\(.*?\)/g, '')) === q);
  return hit ? { id: `uva:${hit.id}`, name: hit.name, address: hit.address || '', location: hit.location, source: 'uva' } : null;
}

// ---------- Talking to Google ----------

function requireKey() {
  if (!KEY) throw new Error('GOOGLE_SERVER_KEY is not set.');
}

async function googlePost(url, body, fieldMask) {
  requireKey();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': fieldMask },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---------- Public functions the server routes use ----------

/**
 * Search suggestions as the user types.
 * UVA nicknames come first. An exact nickname match ("ohill") never calls Google.
 * `session` is an optional token from the phone: Google bills a whole
 * type-then-pick sequence as one session when the same token is reused.
 */
export async function search(input, session, { allowGoogle = true } = {}) {
  const text = String(input || '').trim().slice(0, 100);
  const { exact, partial } = matchUva(text);
  const uva = [...exact, ...partial].map(asSuggestion);

  // Exact UVA match, too short, or bus stops already answer it: no Google call.
  if (!allowGoogle || exact.length || normalize(text).length < 3) return { suggestions: uva.slice(0, 8), usedGoogle: false };

  const cacheKey = normalize(text);
  let fromGoogle = searchCache.read(cacheKey);
  let usedGoogle = false;
  if (!fromGoogle) {
    spend('autocomplete');
    usedGoogle = true;
    const data = await googlePost(
      'https://places.googleapis.com/v1/places:autocomplete',
      {
        input: text,
        locationBias: { circle: { center: GROUNDS, radius: SEARCH_RADIUS_M } },
        includedRegionCodes: ['us'],
        ...(session ? { sessionToken: String(session).slice(0, 64) } : {}),
      },
      'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat',
    );
    fromGoogle = (data.suggestions || [])
      .filter((s) => s.placePrediction)
      .map(({ placePrediction: p }) => ({
        id: p.placeId,
        name: p.structuredFormat?.mainText?.text || '',
        detail: p.structuredFormat?.secondaryText?.text || '',
        source: 'google',
      }));
    searchCache.write(cacheKey, fromGoogle);
  }
  return { suggestions: [...uva, ...fromGoogle].slice(0, 8), usedGoogle };
}

/**
 * Where is this place? Accepts "uva:ohill" (free, from our list) or a Google place ID.
 * Only asks Google for Essentials-tier fields (location + address) to stay in the cheapest tier.
 */
export async function getPlace(id, session) {
  if (String(id).startsWith('uva:')) {
    const p = uvaPlaces.find((x) => `uva:${x.id}` === id && x.location);
    if (!p) return null;
    return { id, name: p.name, address: p.address, location: p.location, source: 'uva' };
  }
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(id)) return null; // not a real Google place ID

  const cached = placeCache.read(id);
  if (cached) return cached;
  spend('placeDetails');
  requireKey();
  const url = new URL(`https://places.googleapis.com/v1/places/${id}`);
  if (session) url.searchParams.set('sessionToken', String(session).slice(0, 64));
  const res = await fetch(url, {
    headers: { 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'id,location,formattedAddress,shortFormattedAddress' },
    signal: AbortSignal.timeout(8_000),
  });
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const place = {
    id,
    address: data.shortFormattedAddress || data.formattedAddress || '',
    location: { lat: data.location.latitude, lng: data.location.longitude },
    source: 'google',
  };
  placeCache.write(id, place);
  return place;
}

// Distance in km between two {lat, lng} points.
function km(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
}
const nearUva = (p) => km(p, { lat: GROUNDS.latitude, lng: GROUNDS.longitude }) <= MAX_TRIP_KM;

/**
 * Walking trip between two points. (CAT/transit gets added in Phase 2 piece 4,
 * after checking which Google price tier its extra fields fall into.)
 * Positions are rounded to ~10 m so nearby requests share a cached answer.
 * Returns null if the points are far from UVA (protects our caps from misuse).
 */
export async function getWalk(from, to) {
  if (![from, to].every((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng) && nearUva(p))) return null;

  const r = (n) => n.toFixed(4);
  const cacheKey = `WALK:${r(from.lat)},${r(from.lng)}>${r(to.lat)},${r(to.lng)}`;
  const cached = routeCache.read(cacheKey);
  if (cached) return { ...cached, cached: true };

  spend('routes');
  const point = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  // Basic fields only, and no traffic-aware options, so this stays in the cheapest (Essentials) tier.
  const fields = ['routes.duration', 'routes.distanceMeters', 'routes.polyline.encodedPolyline'];
  const data = await googlePost(
    'https://routes.googleapis.com/directions/v2:computeRoutes',
    { origin: point(from), destination: point(to), travelMode: 'WALK' },
    fields.join(','),
  );
  const best = data.routes?.[0];
  if (!best) return null;
  const result = {
    seconds: parseInt(best.duration, 10) || 0,
    meters: best.distanceMeters || 0,
    polyline: best.polyline?.encodedPolyline || '',
  };
  routeCache.write(cacheKey, result);
  return { ...result, cached: false };
}

// ---------- CAT (city buses) via Google transit directions ----------

const transitCache = new TimedCache(5 * 60_000); // schedules: reuse an answer for 5 minutes
const CAT_AGENCY = /charlottesville area transit/i;
const seconds = (d) => parseInt(d, 10) || 0; // Google durations look like "315s"

/**
 * CAT bus options between two points, leaving now (or at leaveAtMs, for transfers). Buses only, CAT only.
 * Same Essentials tier as walking (no traffic options). Counts toward the 'routes' cap.
 * Returns a list of { lines, board, alight, walkBeforeSeconds, departAt, arriveAt, ... }
 * with real clock times (ms), so a cached answer stays correct as time passes.
 */
export async function getTransit(from, to, leaveAtMs, arriveByMs) {
  if (![from, to].every((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng) && nearUva(p))) return [];

  const r = (n) => n.toFixed(4);
  // Later departures (transfers) are saved per 2-minute slot.
  const slot = arriveByMs ? `#by${Math.round(arriveByMs / 120_000)}` : leaveAtMs ? `@${Math.round(leaveAtMs / 120_000)}` : '';
  const cacheKey = `TRANSIT:${r(from.lat)},${r(from.lng)}>${r(to.lat)},${r(to.lng)}${slot}`;
  const cached = transitCache.read(cacheKey);
  // Reuse a saved answer only while at least one of its buses can still be caught.
  const startAt = Math.max(Date.now(), leaveAtMs || 0);
  const catchable = (o) => o.departAt - startAt > o.walkBeforeSeconds * 1000 + 30_000;
  if (cached && (cached.length === 0 || cached.some(catchable))) return cached;

  spend('routes');
  const point = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const data = await googlePost(
    'https://routes.googleapis.com/directions/v2:computeRoutes',
    {
      origin: point(from),
      destination: point(to),
      travelMode: 'TRANSIT',
      computeAlternativeRoutes: true,
      transitPreferences: { allowedTravelModes: ['BUS'] },
      // Google takes a departure time OR an arrival time, not both.
      ...(arriveByMs ? { arrivalTime: new Date(arriveByMs).toISOString() } : leaveAtMs ? { departureTime: new Date(leaveAtMs).toISOString() } : {}),
    },
    'routes.polyline.encodedPolyline,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.transitDetails',
  );

  const options = [];
  for (const route of data.routes || []) {
    const steps = route.legs?.[0]?.steps || [];
    const rides = steps.filter((s) => s.travelMode === 'TRANSIT' && s.transitDetails);
    if (!rides.length) continue; // just walking: we already have a walking option
    if (!rides.every((s) => CAT_AGENCY.test(s.transitDetails.transitLine?.agencies?.[0]?.name || ''))) continue;

    const firstIdx = steps.indexOf(rides[0]);
    const lastIdx = steps.indexOf(rides.at(-1));
    const walkBefore = steps.slice(0, firstIdx).reduce((sum, s) => sum + seconds(s.staticDuration), 0);
    const walkAfter = steps.slice(lastIdx + 1).reduce((sum, s) => sum + seconds(s.staticDuration), 0);
    const first = rides[0].transitDetails;
    const last = rides.at(-1).transitDetails;
    const stop = (s) => ({ name: s?.name || '', lat: s?.location?.latLng?.latitude, lng: s?.location?.latLng?.longitude });
    const departAt = Date.parse(first.stopDetails?.departureTime);
    const lastArrive = Date.parse(last.stopDetails?.arrivalTime);
    if (!departAt || !lastArrive) continue;

    options.push({
      lines: rides.map((s) => ({
        name: s.transitDetails.transitLine?.nameShort || s.transitDetails.transitLine?.name || 'CAT',
        color: s.transitDetails.transitLine?.color || '#4a5568',
        headsign: s.transitDetails.headsign || '',
      })),
      board: stop(first.stopDetails?.departureStop),
      alight: stop(last.stopDetails?.arrivalStop),
      stopsCount: rides.reduce((sum, s) => sum + (s.transitDetails.stopCount || 0), 0),
      walkBeforeSeconds: walkBefore,
      departAt,
      rideSeconds: Math.round((lastArrive - departAt) / 1000),
      walkAfterSeconds: walkAfter,
      arriveAt: lastArrive + walkAfter * 1000,
      polyline: route.polyline?.encodedPolyline || '',
    });
  }
  transitCache.write(cacheKey, options);
  return options;
}
