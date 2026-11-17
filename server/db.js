// The ONLY place in the app that talks to Supabase (our free online database).
// Phones never talk to Supabase: they ask our server, and the server checks limits first.
// The secret key lives only in .env / Render's settings (SUPABASE_URL, SUPABASE_SECRET_KEY).
// The tables are locked (row level security, no rules), so only this secret key can use them.
// Tables: supabase/schema.sql (paste into Supabase → SQL Editor once).
//
// If Supabase is missing or down, everything keeps working from memory, like before.

// Accepts "https://abc.supabase.co" or the "…/rest/v1/" form Supabase's Data API page shows.
const BASE = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const KEY = (process.env.SUPABASE_SECRET_KEY || '').trim();

export const configured = Boolean(BASE && KEY);

const FLUSH_MS = 30_000; // save Google usage counts this often
const KEEP_AWAKE_MS = 6 * 60 * 60_000; // free projects pause after 7 days unused: touch it every 6 h
const TIMEOUT_MS = 8_000;

let state = configured ? 'connecting' : 'not configured';
let lastError = null;
let lastOkAt = null;

export function status() {
  return { configured, state, lastOkAt, lastError };
}

// One request to Supabase's REST API (https://supabase.com/docs/guides/api).
async function rest(path, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: KEY, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  // Older "service_role" keys are JWTs (start with "eyJ") and also go in Authorization.
  // Newer "sb_secret_..." keys go only in the apikey header.
  if (KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${KEY}`;
  try {
    const res = await fetch(`${BASE}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
    state = 'ok';
    lastError = null;
    lastOkAt = new Date().toISOString();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    state = 'error';
    lastError = err.message;
    throw err;
  }
}

// ---------- Google usage counts (so our caps survive restarts and Render sleeping) ----------

// Counts not saved yet: "routes|2026-11-12" -> 3
const pending = new Map();

export function addGoogleUsage(kind, periods) {
  if (!configured) return;
  for (const period of periods) {
    const k = `${kind}|${period}`;
    pending.set(k, (pending.get(k) || 0) + 1);
  }
}

// Saved totals for these periods, e.g. ["2026-11-12", "2026-11"] → [{ kind, period, count }]
export async function loadGoogleUsage(periods) {
  if (!configured) return [];
  const list = periods.map((p) => `"${p}"`).join(',');
  return rest(`google_usage?select=kind,period,count&period=in.(${encodeURIComponent(list)})`);
}

export async function flushGoogleUsage() {
  if (!configured || !pending.size) return;
  const batch = [...pending];
  pending.clear();
  for (const [k, amount] of batch) {
    const [kind, period] = k.split('|');
    try {
      await rest('rpc/add_google_usage', { method: 'POST', body: { p_kind: kind, p_period: period, p_amount: amount } });
    } catch (err) {
      // Keep it for the next try.
      pending.set(k, (pending.get(k) || 0) + amount);
      console.error('[db] could not save Google usage:', err.message);
    }
  }
}

// ---------- Rider reports (server/reports.js) ----------

const REPORT_FIELDS = 'id,kind,route_id,vehicle_id,stop_id,device,created_at,expires_at';

export async function insertReport(row) {
  return rest(`reports?select=${REPORT_FIELDS}`, { method: 'POST', body: row, prefer: 'return=representation' });
}

// Reports that haven't expired and weren't removed by the admin, with their "still there?" votes.
export async function loadLiveReports() {
  const now = encodeURIComponent(new Date().toISOString());
  return rest(
    `reports?select=${REPORT_FIELDS},report_votes(device,still_there)` +
      `&removed=is.false&expires_at=gt.${now}&order=created_at.asc&limit=1000`,
  );
}

// One phone's "still there?" answer (a second answer replaces the first).
export async function saveVote(reportId, device, stillThere) {
  return rest('report_votes', {
    method: 'POST',
    body: { report_id: reportId, device, still_there: stillThere, created_at: new Date().toISOString() },
    prefer: 'resolution=merge-duplicates',
  });
}

export async function setReportExpiry(id, expiresAtIso) {
  return rest(`reports?id=eq.${Number(id)}`, { method: 'PATCH', body: { expires_at: expiresAtIso } });
}

// Admin page: everything from the last day, including removed reports.
export async function loadRecentReports(sinceIso) {
  return rest(
    `reports?select=${REPORT_FIELDS},removed,report_votes(still_there)` +
      `&created_at=gt.${encodeURIComponent(sinceIso)}&order=created_at.desc&limit=500`,
  );
}

// Admin "Remove": hide reports (kept in the database, marked removed).
export async function removeReportById(id) {
  return rest(`reports?id=eq.${Number(id)}`, { method: 'PATCH', body: { removed: true } });
}

export async function removeReportsByDevice(device, sinceIso) {
  if (!/^[0-9a-f]{32}$/.test(device)) throw new Error('bad device');
  return rest(`reports?device=eq.${device}&created_at=gt.${encodeURIComponent(sinceIso)}`, {
    method: 'PATCH',
    body: { removed: true },
  });
}

// Clean-up: delete reports (and their votes) older than this.
export async function deleteReportsBefore(iso) {
  return rest(`reports?created_at=lt.${encodeURIComponent(iso)}`, { method: 'DELETE' });
}

// ---------- Leave-now notifications (server/push.js) ----------

export async function loadPushSubs() {
  return rest('push_subs?select=device,endpoint,p256dh,auth,plan&limit=5000');
}

// Add or replace one phone's row (same device = replace).
export async function savePushSub(row) {
  return rest('push_subs', {
    method: 'POST',
    body: { ...row, updated_at: new Date().toISOString() },
    prefer: 'resolution=merge-duplicates',
  });
}

export async function deletePushSub(device) {
  if (!/^[0-9a-f]{32}$/.test(device)) throw new Error('bad device');
  return rest(`push_subs?device=eq.${device}`, { method: 'DELETE' });
}

// Claim "this reminder is being sent" (only the first server to ask wins).
// Returns true = go ahead and send, false = already sent. Throws if the database can't answer.
export async function claimReminder(device, classId, day) {
  const rows = await rest('reminder_sends', {
    method: 'POST',
    body: { device, class_id: classId, day },
    prefer: 'resolution=ignore-duplicates,return=representation',
  });
  return Array.isArray(rows) && rows.length > 0;
}

export async function deleteReminderSendsBefore(day) {
  return rest(`reminder_sends?day=lt.${encodeURIComponent(day)}`, { method: 'DELETE' });
}

// ---------- How many people use the app (server/visitors.js) ----------

// "This phone opened the app today" (+ its first day ever). Repeats are ignored.
export async function recordPhoneDay(device, day) {
  await rest('phones', { method: 'POST', body: { device, first_day: day }, prefer: 'resolution=ignore-duplicates' });
  await rest('phone_days', { method: 'POST', body: { device, day }, prefer: 'resolution=ignore-duplicates' });
}

export async function phoneStats(today, weekStart, exclude) {
  return rest('rpc/phone_stats', { method: 'POST', body: { p_today: today, p_week_start: weekStart, p_exclude: exclude } });
}

export async function deletePhoneDaysBefore(day) {
  return rest(`phone_days?day=lt.${encodeURIComponent(day)}`, { method: 'DELETE' });
}

export async function loadSetting(key) {
  const rows = await rest(`app_settings?select=value&key=eq.${encodeURIComponent(key)}`);
  return rows?.[0]?.value ?? null;
}

export async function saveSetting(key, value) {
  return rest('app_settings', {
    method: 'POST',
    body: { key, value, updated_at: new Date().toISOString() },
    prefer: 'resolution=merge-duplicates',
  });
}

// ---------- Background jobs ----------

if (configured) {
  setInterval(() => flushGoogleUsage(), FLUSH_MS).unref();
  setInterval(() => rest('google_usage?select=kind&limit=1').catch(() => {}), KEEP_AWAKE_MS).unref();

  // Render stops the server (redeploy, sleep) with SIGTERM: save counts first.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, async () => {
      await Promise.race([flushGoogleUsage(), new Promise((r) => setTimeout(r, 4_000))]);
      process.exit(0);
    });
  }
}
