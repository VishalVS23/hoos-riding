// Rider reports on the phone: the buttons in bus/stop popups, and the "2 riders say Packed" lines.
// The server does the checking and storing (server/reports.js). This phone only keeps a random ID
// (never your name or location), which the server scrambles before saving.

const DEVICE_KEY = 'hoos-riding.device';

export const KINDS = {
  packed: { label: 'Packed', icon: '😣' },
  seats_open: { label: 'Seats open', icon: '💺', good: true },
  broke_down: { label: 'Broke down', icon: '🛠️' },
  detour: { label: 'Detour', icon: '↪️' },
  ramp_broken: { label: 'Ramp not working', icon: '♿' },
  skipped_stop: { label: 'Skipped stop', icon: '⏭️' },
};
export const BUS_KINDS = ['packed', 'seats_open', 'broke_down', 'detour', 'ramp_broken'];
export const STOP_KINDS = ['skipped_stop', 'detour'];

let summary = { buses: {}, stops: {} };
let demo = false;
let afterSend = () => {};

export function initReports(options) {
  demo = options.demo;
  afterSend = options.afterSend || afterSend;
}

// Called with each /api/vehicles answer.
export function setReports(s) {
  if (s && s.buses && s.stops) summary = s;
}

export const busReports = (vehicleId) => summary.buses[vehicleId] || [];
export const stopReports = (stopId) => summary.stops[stopId] || [];
// Reports worth warning about (everything except "Seats open").
export const busWarnings = (vehicleId) => busReports(vehicleId).filter((r) => !KINDS[r.kind]?.good);

// A random ID for this phone, made once and kept on the device.
let memoryId = null;
export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    // Storage blocked (private browsing): an ID for this visit only.
    memoryId ||= `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return memoryId;
  }
}

// "2 riders say Packed · 3 min ago" lines. Returns null if there are none.
export function reportList(items) {
  if (!items.length) return null;
  const box = document.createElement('div');
  box.className = 'report-list';
  for (const r of items) {
    const k = KINDS[r.kind] || { label: r.kind, icon: '⚠️' };
    // Card: [icon badge] "Packed" (big) / "2 riders · 3 min ago" (small) / "✓ Matches live data"
    const row = document.createElement('div');
    row.className = `report-item kind-${r.kind}`;
    const icon = document.createElement('span');
    icon.className = 'report-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = k.icon;
    const text = document.createElement('div');
    text.className = 'report-text';
    const what = document.createElement('div');
    what.className = 'report-what';
    what.textContent = k.label;
    const who = document.createElement('div');
    who.className = 'report-who';
    const notAnymore = r.downs ? ` · ${r.downs} say${r.downs === 1 ? 's' : ''} not anymore` : '';
    const stillThere = r.ups ? ` · ${r.ups} confirmed` : '';
    who.textContent = `${r.riders > 1 ? `${r.riders} riders say so` : '1 rider says so'}${stillThere}${notAnymore} · ${ago(r.newestAt)}`;
    text.append(what, who);
    if (r.mine) {
      const mine = document.createElement('div');
      mine.className = 'report-who';
      mine.textContent = 'You reported this';
      text.append(mine);
    } else if (r.id != null) {
      text.append(voteButtons(r));
    }
    if (r.check?.result === 'supported' && r.check.note) {
      const ok = document.createElement('div');
      ok.className = 'report-check';
      ok.textContent = `✓ Matches live data: ${r.check.note}`;
      text.append(ok);
    }
    row.append(icon, text);
    box.append(row);
  }
  return box;
}

// "Report this bus" + one-tap buttons. target = { vehicleId } or { stopId }.
export function reportButtons(kinds, target, heading) {
  const box = document.createElement('div');
  box.className = 'report-box';
  const title = document.createElement('div');
  title.className = 'popup-label';
  title.textContent = heading;
  const grid = document.createElement('div');
  grid.className = 'report-buttons';
  const msg = document.createElement('div');
  msg.className = 'report-msg';
  msg.setAttribute('role', 'status');

  for (const kind of kinds) {
    const k = KINDS[kind];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `report-button kind-${kind}`;
    btn.textContent = `${k.icon} ${k.label}`;
    btn.addEventListener('click', async () => {
      for (const b of grid.children) b.disabled = true;
      msg.className = 'report-msg';
      msg.textContent = 'Sending…';
      const result = await send(kind, target);
      msg.textContent = result.ok ? `Thanks! Other riders can see “${k.label}” for the next 15 min.` : result.error;
      msg.classList.toggle('error', !result.ok);
      for (const b of grid.children) b.disabled = false;
      if (result.ok) afterSend();
    });
    grid.append(btn);
  }
  box.append(title, grid, msg);
  return box;
}

// "Still there?" 👍 Still there / 👎 Not anymore (one answer per phone; tapping again changes it).
function voteButtons(r) {
  const row = document.createElement('div');
  row.className = 'vote-row';
  const label = document.createElement('span');
  label.className = 'vote-label';
  label.textContent = 'Still there?';
  row.append(label);
  for (const [up, text] of [[true, '👍 Yes'], [false, '👎 No']]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `vote-button ${up ? 'up' : 'down'}`;
    btn.textContent = text;
    btn.setAttribute('aria-pressed', String(r.myVote === up));
    btn.setAttribute('aria-label', up ? 'Yes, still there' : 'No, not anymore');
    btn.addEventListener('click', async () => {
      for (const b of row.querySelectorAll('button')) b.disabled = true;
      const result = await post(`/api/reports/${encodeURIComponent(r.id)}/vote`, { stillThere: up, device: deviceId() });
      if (result.ok) {
        label.textContent = up ? 'Thanks! Kept it up.' : 'Thanks!';
        afterSend();
      } else {
        label.textContent = result.error;
        for (const b of row.querySelectorAll('button')) b.disabled = false;
      }
    });
    row.append(btn);
  }
  return row;
}

async function post(path, body) {
  try {
    const res = await fetch(`${path}${demo ? '?demo=1' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true } : { ok: false, error: data.error || 'Couldn’t send that. Try again?' };
  } catch {
    return { ok: false, error: 'No connection. Try again?' };
  }
}

async function send(kind, target) {
  try {
    const res = await fetch(`/api/reports${demo ? '?demo=1' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, ...target, device: deviceId() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || 'Couldn’t send that. Try again?' };
    return { ok: true };
  } catch {
    return { ok: false, error: 'No connection. Try again?' };
  }
}

function ago(ms) {
  const mins = Math.round((Date.now() - ms) / 60_000);
  return mins < 1 ? 'just now' : `${mins} min ago`;
}
