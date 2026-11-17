// How many people use the app. Only the owner sees this: on /admin and in a nightly push.
//
// Every phone already sends its random ID (X-Device) when it asks for the buses. The first time
// we see a phone on a given (Eastern) day, we save its SCRAMBLED ID + the day in Supabase
// (tables phone_days + phones, supabase/schema.sql). Never a name, location or the real ID.
// Rows older than 90 days are deleted, so "new" means "not seen in the last 90 days".
//
// The owner's own devices can be left out of the counts:
// - a phone: send a test notification from it (My classes → 🔔 Reminders), then press
//   "This is my phone" on /admin within 15 min. That phone also gets the nightly numbers.
// - a laptop browser: open /admin in it and press "Don't count this browser".

import * as db from './db.js';
import { scrambleDevice } from './reports.js';
import { easternDay, easternTime } from './reminders.js';

const KEEP_DAYS = 90;
const DIGEST_AT = '21:00'; // nightly numbers at 9 PM Eastern (sent until 9:59 if the server was asleep)
const PAIR_WINDOW_MS = 15 * 60_000;

const seenToday = new Set(); // "2026-11-16|<scrambled id>": already saved today, don't ask Supabase again
let seenDay = '';
let owner = { notify: null, exclude: [] }; // scrambled IDs

const today = () => easternDay(Date.now()).iso;
const weekStart = () => easternDay(Date.now() - 6 * 86_400_000).iso;

export async function load() {
  if (!db.configured) return;
  try {
    const saved = await db.loadSetting('owner');
    if (saved) owner = { notify: saved.notify || null, exclude: Array.isArray(saved.exclude) ? saved.exclude : [] };
  } catch (err) {
    console.error('[visitors] could not load owner settings:', err.message);
  }
}

/** A phone asked for buses. Cheap: Supabase is asked at most once per phone per day. */
export function seen(rawDevice) {
  if (!db.configured || typeof rawDevice !== 'string' || rawDevice.length < 8 || rawDevice.length > 100) return;
  const day = today();
  if (day !== seenDay) {
    seenToday.clear();
    seenDay = day;
  }
  const device = scrambleDevice(rawDevice);
  const key = `${day}|${device}`;
  if (seenToday.has(key)) return;
  seenToday.add(key);
  db.recordPhoneDay(device, day).catch((err) => {
    seenToday.delete(key); // try again on its next visit
    console.error('[visitors] could not save:', err.message);
  });
}

export async function stats() {
  if (!db.configured) return null;
  return db.phoneStats(today(), weekStart(), owner.exclude);
}

export function ownerInfo() {
  return { phonePaired: Boolean(owner.notify), notCounted: owner.exclude.length };
}

async function saveOwner() {
  await db.saveSetting('owner', owner);
}

function exclude(device) {
  if (!owner.exclude.includes(device)) owner.exclude = [...owner.exclude, device].slice(-20);
}

/** "This is my phone": the phone that most recently sent a test notification. */
export async function pairPhone(lastTest) {
  if (!lastTest || Date.now() - lastTest.at > PAIR_WINDOW_MS) {
    return { ok: false, error: 'No test notification in the last 15 min. Send one from your phone first (My classes → 🔔 Reminders → Send a test notification).' };
  }
  owner.notify = lastTest.device;
  exclude(lastTest.device);
  await saveOwner();
  return { ok: true };
}

/** "Don't count this browser" (the admin page sends this browser's random ID). */
export async function excludeBrowser(rawDevice) {
  if (typeof rawDevice !== 'string' || rawDevice.length < 8 || rawDevice.length > 100) return { ok: false, error: 'This browser has no HooMaps ID yet. Open the map in it once, then try again.' };
  exclude(scrambleDevice(rawDevice));
  await saveOwner();
  return { ok: true };
}

export async function resetOwner() {
  owner = { notify: null, exclude: [] };
  await saveOwner();
}

export function digestText(s, extra = {}) {
  const parts = [];
  parts.push(s.today ? `${s.today} phone${s.today === 1 ? '' : 's'} (${s.newToday} new)` : 'No one else opened it today');
  parts.push(`${s.week} this week`);
  if (extra.trips != null) parts.push(`${extra.trips} trip lookups`);
  if (extra.capsHit?.length) parts.push(`⚠️ cap hit: ${extra.capsHit.join(', ')}`);
  return `${parts.join(' · ')}. ${s.allTime} phone${s.allTime === 1 ? '' : 's'} so far.`;
}

/** Admin page's "Send me tonight's numbers now" button. */
export async function sendDigestNow(send, extra) {
  if (!owner.notify) return { ok: false, error: 'Pair your phone first.' };
  const sent = await send(owner.notify, { title: '📊 HooMaps today', body: digestText(await stats(), extra), tag: 'daily-stats', url: '/admin' });
  return sent ? { ok: true } : { ok: false, error: 'Couldn’t reach your phone. Turn reminders off and on again there, send a test, then pair again.' };
}

/** Nightly numbers to the owner's phone. send(device, payload) → true/false; extra() → { trips, capsHit }. */
export function startDigest({ send, extra = () => ({}) }) {
  if (!db.configured) return;
  const tick = async () => {
    if (!owner.notify) return;
    const now = Date.now();
    const day = easternDay(now);
    const at = easternTime(day, DIGEST_AT);
    if (now < at || now > at + 59 * 60_000) return;
    try {
      // Same "only once" claim as class reminders, so restarts/deploys never send it twice.
      if (!(await db.claimReminder(owner.notify, 'daily-stats', day.iso))) return;
      const s = await stats();
      await send(owner.notify, { title: '📊 HooMaps today', body: digestText(s, extra()), tag: 'daily-stats', url: '/admin' });
    } catch (err) {
      console.error('[visitors] nightly numbers:', err.message);
    }
  };
  setInterval(tick, 60_000).unref();
  // Clean-up: forget days older than 90 days (checked every 6 h).
  setInterval(() => {
    db.deletePhoneDaysBefore(easternDay(Date.now() - KEEP_DAYS * 86_400_000).iso).catch(() => {});
  }, 6 * 3600_000).unref();
}
