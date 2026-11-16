// Leave-now notifications: sending "web push" notifications to phones that turned reminders on.
//
// How web push works: when you turn reminders on, your phone's browser makes a private "address"
// (a link at Apple / Google / Mozilla, plus two keys). We keep that address, and later send a small
// encrypted message to it; the phone shows it as a notification, even with HooMaps closed.
// Our two VAPID keys (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in .env + Render) prove the messages come from us.
//
// Saved in Supabase (table push_subs) so reminders survive restarts; kept in memory too.
// Phones are known only by a scrambled random ID (same as rider reports). Never a name or location.

import webpush from 'web-push';
import * as db from './db.js';
import { scrambleDevice } from './reports.js';

const PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || '').trim();
const PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || '').trim();
export const configured = Boolean(PUBLIC_KEY && PRIVATE_KEY);
export const publicKey = () => (configured ? PUBLIC_KEY : null);

// "subject" = how push services can contact us about problems. Our site address (no email needed).
if (configured) webpush.setVapidDetails('https://hoomaps.onrender.com', PUBLIC_KEY, PRIVATE_KEY);
else console.warn('No VAPID keys: leave-now notifications are off (add VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).');

const MAX_PHONES = 500; // safety limit
const TEST_LIMIT = 3; // test notifications per phone...
const TEST_WINDOW_MS = 10 * 60_000; // ...per 10 minutes

// Only send to the real push services (so nobody can make our server send requests elsewhere).
const PUSH_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/, // Chrome, Android, Edge (some)
  /(^|\.)push\.apple\.com$/, // iPhone / Safari
  /(^|\.)push\.services\.mozilla\.com$/, // Firefox
  /(^|\.)notify\.windows\.com$/, // Edge on Windows
];

const subs = new Map(); // scrambled device -> { endpoint, keys: { p256dh, auth }, plan }
const tests = new Map(); // scrambled device -> [timestamps]

function isValid(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1000) return false;
  let url;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname))) return false;
  const { p256dh, auth } = sub.keys || {};
  return typeof p256dh === 'string' && typeof auth === 'string' && p256dh.length < 200 && auth.length < 100;
}

// At startup: load every phone's reminder address from Supabase.
export async function load() {
  if (!configured || !db.configured) return;
  try {
    for (const row of await db.loadPushSubs()) {
      subs.set(row.device, { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth }, plan: row.plan });
    }
    console.log(`[push] ${subs.size} phone(s) with reminders on`);
  } catch (err) {
    console.error('[push] could not load from Supabase:', err.message);
  }
}

/** A phone turned reminders on (or re-sent its address). Returns { ok } or { ok: false, status, error }. */
export async function subscribe(rawDevice, subscription) {
  if (!configured) return { ok: false, status: 503, error: 'Notifications aren’t set up on the server yet.' };
  if (!rawDevice || !isValid(subscription)) return { ok: false, status: 400, error: 'That notification setup didn’t look right. Try again?' };
  const device = scrambleDevice(rawDevice);
  if (!subs.has(device) && subs.size >= MAX_PHONES) return { ok: false, status: 503, error: 'Too many phones have reminders on right now.' };
  const entry = { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }, plan: subs.get(device)?.plan || null };
  subs.set(device, entry);
  await saveRow(device, entry);
  return { ok: true };
}

export async function unsubscribe(rawDevice) {
  if (!rawDevice) return;
  const device = scrambleDevice(rawDevice);
  subs.delete(device);
  if (db.configured) await db.deletePushSub(device).catch((err) => console.error('[push] delete:', err.message));
}

export const isOn = (rawDevice) => Boolean(rawDevice) && subs.has(scrambleDevice(rawDevice));

// For server/reminders.js: every phone with reminders on.
export const entries = () => subs.entries();

// ---------- The reminder plan: classes + "usually leave from" (sent by src/notify.js) ----------

const GROUNDS = { lat: 38.0336, lng: -78.508 };
const NEAR_M = 8_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_KEYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
const planSaves = new Map(); // device -> [timestamps] (max 30 per 10 min)

const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

function cleanPlace(p) {
  const lat = Number(p?.lat);
  const lng = Number(p?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(lat - GROUNDS.lat) / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(GROUNDS.lat)) * Math.sin(rad(lng - GROUNDS.lng) / 2) ** 2;
  if (12_742_000 * Math.asin(Math.sqrt(h)) > NEAR_M) return null; // must be near Grounds
  return { name: cleanText(p.name, 80) || 'Class', lat, lng };
}

// Keep only what reminders need, in a safe shape.
function cleanPlan(plan) {
  const classes = (Array.isArray(plan?.classes) ? plan.classes : []).slice(0, 20).map((c) => {
    const days = (Array.isArray(c?.days) ? c.days : []).filter((d) => DAY_KEYS.includes(d));
    const start = /^\d{2}:\d{2}$/.test(c?.start) ? c.start : null;
    const place = cleanPlace(c?.place);
    if (!days.length || !start || !place) return null;
    return {
      id: cleanText(c.id, 60) || cleanText(c.name, 40),
      name: cleanText(c.name, 40) || 'class',
      days,
      start,
      place,
      from: DATE_RE.test(c.from) ? c.from : null,
      until: DATE_RE.test(c.until) ? c.until : null,
      skip: (Array.isArray(c.skip) ? c.skip : []).filter((d) => DATE_RE.test(d)).slice(0, 100),
    };
  }).filter(Boolean);
  return { classes, leaveFrom: plan?.leaveFrom ? cleanPlace(plan.leaveFrom) : null };
}

/** The phone's classes changed (or reminders were just turned on). */
export async function setPlan(rawDevice, plan) {
  if (!rawDevice) return { ok: false, status: 400, error: 'Missing phone ID.' };
  const device = scrambleDevice(rawDevice);
  const entry = subs.get(device);
  if (!entry) return { ok: false, status: 404, error: 'Reminders aren’t on for this phone.' };
  const now = Date.now();
  const recent = (planSaves.get(device) || []).filter((t) => now - t < TEST_WINDOW_MS);
  if (recent.length >= 30) return { ok: false, status: 429, error: 'Too many changes. Try again in a few minutes.' };
  planSaves.set(device, [...recent, now]);
  entry.plan = cleanPlan(plan);
  await saveRow(device, entry);
  return { ok: true, classes: entry.plan.classes.length, leaveFrom: Boolean(entry.plan.leaveFrom) };
}

/** "Send me a test notification". */
export async function sendTest(rawDevice) {
  if (!rawDevice) return { ok: false, status: 400, error: 'Turn reminders on first.' };
  const device = scrambleDevice(rawDevice);
  if (!subs.has(device)) return { ok: false, status: 404, error: 'Reminders aren’t on for this phone. Turn them on first.' };
  const now = Date.now();
  const recent = (tests.get(device) || []).filter((t) => now - t < TEST_WINDOW_MS);
  if (recent.length >= TEST_LIMIT) return { ok: false, status: 429, error: 'That’s a few tests already. Try again in a few minutes.' };
  tests.set(device, [...recent, now]);
  // With classes saved, tapping the test opens a class's trip (like a real reminder).
  const c = subs.get(device).plan?.classes?.[0];
  const sent = await sendTo(device, {
    title: 'HooMaps 🔔',
    body: c
      ? `Notifications work! Tap to see your trip to ${c.name} (${c.place.name}), like a real reminder.`
      : 'Notifications work! Leave-now reminders will look like this.',
    tag: 'test',
    url: c ? `/?remind=${encodeURIComponent(c.id)}` : '/',
  });
  return sent ? { ok: true } : { ok: false, status: 502, error: 'Couldn’t send it. Try turning reminders off and on again.' };
}

/** Send one notification. Returns true if the push service accepted it. */
export async function sendTo(device, payload) {
  const entry = subs.get(device);
  if (!entry) return false;
  try {
    await webpush.sendNotification(entry, JSON.stringify(payload), { TTL: 10 * 60, urgency: 'high' });
    return true;
  } catch (err) {
    // 404 / 410 = the phone turned notifications off or the app was removed: forget it.
    if (err.statusCode === 404 || err.statusCode === 410) {
      console.log('[push] a phone’s notification address expired: removed');
      subs.delete(device);
      if (db.configured) db.deletePushSub(device).catch(() => {});
    } else {
      console.error('[push] send failed:', err.statusCode || '', err.body || err.message);
    }
    return false;
  }
}

async function saveRow(device, entry) {
  if (!db.configured) return;
  try {
    await db.savePushSub({ device, endpoint: entry.endpoint, p256dh: entry.keys.p256dh, auth: entry.keys.auth, plan: entry.plan });
  } catch (err) {
    console.error('[push] could not save to Supabase:', err.message);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const map of [tests, planSaves]) for (const [k, list] of map) if (!list.some((t) => now - t < TEST_WINDOW_MS)) map.delete(k);
}, TEST_WINDOW_MS).unref();
