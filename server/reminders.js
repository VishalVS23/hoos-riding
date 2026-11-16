// Leave-now reminders: buzz each phone 2 minutes before it's time to leave for class.
//
// Every minute (Eastern time), for every phone with reminders on (server/push.js) and a plan
// (its classes + "usually leave from" place, sent by src/notify.js):
//   1. ~1 hour before a class: plan the trip like the app does ("arrive by" 3 min before class),
//      from the previous class's building that day, or from "usually leave from" for the first class.
//   2. ~10 min before leaving: plan again with live buses (a bus may be late or bunched).
//   3. 2 min before the leave-by time: send "Leave now for CS 2100: Gold Line from …".
// No reminder when: same building as the previous class, a break day / outside the term,
// or a first class with no "usually leave from" place.
//
// Google cost: each trip lookup = up to 2 Routes calls (walk + CAT), but answers are cached and
// shared between classmates; a cap of REMINDERS_PER_DAY keeps the total small.

const ZONE = 'America/New_York';
const TICK_MS = 60_000;
const EARLY_MS = 3 * 60_000; // aim to arrive 3 min before class (same as the app)
const PLAN_AHEAD_MS = 60 * 60_000; // first trip lookup this long before class (long trips leave early)
const RECHECK_BEFORE_LEAVE_MS = 10 * 60_000; // second lookup this long before leave-by
const BUZZ_BEFORE_LEAVE_MS = 2 * 60_000; // buzz this long before leave-by
const LATE_SEND_WINDOW_MS = 5 * 60_000; // missed the moment (restart)? still send within 5 min, else skip
const SAME_BUILDING_M = 120;
const REMINDERS_PER_DAY = 60; // whole server, all phones
const DAY_KEYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

/**
 * entries(): [device, { plan }] for every phone with reminders on
 * send(device, payload): sends a notification, resolves true/false
 * planTrip({ from, to, arriveByMs }): the /api/trip answer
 * claim(device, classId, day): resolves true if this server may send (false = already sent,
 *   e.g. before a restart or by a second server during a deploy). Optional.
 */
export function makeReminders({ entries, send, planTrip, metersBetween, claim = async () => true, log = console }) {
  const state = new Map(); // "device|classId|date" -> { from, leaveAtMs, sendAtMs, payload, rechecked, sent, skip }
  let countDay = '';
  let count = 0;
  let busy = false;

  async function tick(now = Date.now()) {
    if (busy) return; // a slow tick (Google lookups) is still running
    busy = true;
    try {
      const today = easternDay(now);
      if (today.iso !== countDay) {
        countDay = today.iso;
        count = 0;
        for (const key of state.keys()) if (!key.endsWith(`|${today.iso}`)) state.delete(key);
      }
      for (const [device, entry] of entries()) {
        const plan = entry.plan;
        if (!plan?.classes?.length) continue;
        const todays = plan.classes
          .filter((c) => c.days.includes(today.dayKey) && meetsOn(c, today.iso) && c.place)
          .sort((a, b) => a.start.localeCompare(b.start));
        for (const [i, c] of todays.entries()) {
          await handleClass({ device, c, prev: todays[i - 1] || null, leaveFrom: plan.leaveFrom, today, now });
        }
      }
    } catch (err) {
      log.error('[reminders]', err.message);
    } finally {
      busy = false;
    }
  }

  async function handleClass({ device, c, prev, leaveFrom, today, now }) {
    const startMs = easternTime(today, c.start);
    if (startMs <= now || startMs - now > PLAN_AHEAD_MS) return;
    const key = `${device}|${c.id}|${today.iso}`;
    let s = state.get(key);

    if (!s) {
      const from = prev ? prev.place : leaveFrom;
      if (!from) return state.set(key, { skip: 'no start place' });
      if (metersBetween(from, c.place) < SAME_BUILDING_M) return state.set(key, { skip: 'same building' });
      if (count >= REMINDERS_PER_DAY) {
        log.warn('[reminders] daily cap reached: skipping');
        return state.set(key, { skip: 'daily cap' });
      }
      count++;
      s = { from };
      state.set(key, s);
      await lookUp(s, c, startMs, now);
    } else if (s.skip || s.sent) {
      return;
    } else if (!s.rechecked && s.leaveAtMs - now <= RECHECK_BEFORE_LEAVE_MS && s.sendAtMs > now + 60_000) {
      s.rechecked = true;
      await lookUp(s, c, startMs, now); // fresher live bus times
    }

    if (!s.payload || now < s.sendAtMs) return;
    s.sent = true;
    if (now - s.sendAtMs > LATE_SEND_WINDOW_MS) return; // too late to be useful (e.g. server was asleep)
    // Only one reminder per class per day, even across restarts and side-by-side servers.
    let mine = true;
    try {
      mine = await claim(device, c.id, today.iso);
    } catch (err) {
      log.warn('[reminders] could not check "already sent" (sending anyway):', err.message);
    }
    if (!mine) return;
    const ok = await send(device, s.payload);
    if (!ok) log.warn('[reminders] a reminder could not be delivered');
  }

  async function lookUp(s, c, startMs, now) {
    const target = startMs - EARLY_MS;
    let trip;
    try {
      trip = await planTrip({ from: s.from, to: c.place, arriveByMs: Math.max(target, now + 60_000) });
    } catch (err) {
      log.error('[reminders] trip', err.message);
    }
    const top = trip?.options?.[0];
    const leaveAtMs = top && !trip.tooLate ? now + top.leaveBySeconds * 1000 : now;
    s.leaveAtMs = leaveAtMs;
    s.sendAtMs = leaveAtMs - BUZZ_BEFORE_LEAVE_MS;
    s.payload = {
      title: `Leave now for ${c.name}`,
      body: `${howText(top, trip, now)}. Class at ${clockText(startMs)} in ${c.place.name}.`,
      tag: `class-${c.id}`, // a newer reminder for the same class replaces an older one
      url: `/?remind=${encodeURIComponent(c.id)}`, // tapping it opens this class's trip (src/main.js)
    };
  }

  return {
    tick,
    start() {
      setInterval(() => tick(), TICK_MS).unref();
      tick();
    },
    status: () => ({ today: countDay, remindersToday: count, cap: REMINDERS_PER_DAY }),
  };
}

// "🚌 Gold Line from McCormick Rd @ Alderman Rd, bus at 9:14 AM"
function howText(top, trip, now) {
  if (!top) return trip?.tooLate ? '⏰ Even walking is tight' : '⏰ Check HooMaps for your trip';
  if (trip.tooLate) return '⏰ Even walking is tight';
  const at = (seconds) => clockText(now + seconds * 1000);
  if (top.type === 'walk') return `🚶 Walk, about ${Math.max(1, Math.round(top.seconds / 60))} min`;
  if (top.type === 'bus') {
    const when = top.estimated ? `buses every ~${Math.round(top.headwaySeconds / 60)} min` : `bus at ${at(top.busInSeconds)}`;
    return `🚌 ${top.route.name.trim()} from ${top.board.name}, ${when}`;
  }
  if (top.type === 'cat') {
    const lines = top.lines.map((l) => l.name).join(' → ');
    return `🚌 CAT ${lines}${top.board?.name ? ` from ${top.board.name}` : ''}, bus at ${at(top.busInSeconds)}`;
  }
  if (top.type === 'transfer') {
    const cat = `CAT ${top.cat.lines.map((l) => l.name).join(' → ')}`;
    const uva = top.uva.route.name.trim();
    return `🚌 ${top.direction === 'uva-cat' ? `${uva} → ${cat}` : `${cat} → ${uva}`}`;
  }
  return '🚌 Take the bus';
}

const meetsOn = (c, iso) => (!c.from || iso >= c.from) && (!c.until || iso <= c.until) && !(c.skip || []).includes(iso);

// ---------- Eastern time (Render's clock is UTC) ----------

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
});

function zoned(ms) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, weekday: p.weekday };
}

// { iso: '2026-11-16', dayKey: 'mo', y, mo, d } for "now" in Charlottesville.
export function easternDay(ms) {
  const z = zoned(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return { iso: `${z.y}-${pad(z.mo)}-${pad(z.d)}`, dayKey: DAY_KEYS[new Date(Date.UTC(z.y, z.mo - 1, z.d)).getUTCDay()], y: z.y, mo: z.mo, d: z.d };
}

// "09:30" on that Eastern day → ms since 1970 (handles daylight saving time).
export function easternTime(day, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const guess = Date.UTC(day.y, day.mo - 1, day.d, h, m);
  const z = zoned(guess);
  const offset = Date.UTC(z.y, z.mo - 1, z.d, z.h, z.mi, z.s) - guess; // Eastern minus UTC
  return guess - offset;
}

const clockText = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' });
