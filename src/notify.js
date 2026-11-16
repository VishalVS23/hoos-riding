// Leave-now notifications on the phone: the "🔔 Reminders" window in My classes.
// Turn notifications on/off, pick "Usually leave from", send a test.
// While reminders are on, this phone sends its classes + "usually leave from" to our server
// (syncPlan) whenever they change; the server buzzes 2 min before leave-by (server/reminders.js).
//
// Turning on: the phone asks you to allow notifications, then its browser makes a private address
// that our server can send to (server/push.js). Turning off deletes it from our server.
// The service worker (public/sw.js) shows the notifications, so they only work in the built app
// (the live site or `npm run preview`), not in `npm run dev`.

import { deviceId } from './reports.js';
import { attachAutocomplete } from './autocomplete.js';

const ON_KEY = 'hoos-riding.reminders'; // '1' while reminders are on for this phone
const FROM_KEY = 'hoos-riding.leave-from'; // { name, location } for the first class of the day
let getClasses = () => [];
let syncTimer = null;

const isIPhone = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let dialog = null;

/** Called by classes.js at startup with a way to read the class list. */
export function initReminders(classesGetter) {
  getClasses = classesGetter;
  if (remindersOn()) syncPlan({ soon: true }); // make sure the server has the latest
}

const remindersOn = () => readStorage(ON_KEY) === '1';
export const leaveFrom = () => {
  try {
    return JSON.parse(readStorage(FROM_KEY) || 'null');
  } catch {
    return null;
  }
};

/** Send the classes + "usually leave from" to the server (if reminders are on). */
export function syncPlan({ soon = false } = {}) {
  if (!remindersOn()) return Promise.resolve(null);
  clearTimeout(syncTimer);
  if (soon) {
    // Several changes in a row (an import): send once, 2 s after the last.
    syncTimer = setTimeout(() => syncPlan(), 2_000);
    return Promise.resolve(null);
  }
  const point = (p) => (p?.location ? { name: p.name, lat: p.location.lat, lng: p.location.lng } : null);
  const plan = {
    leaveFrom: point(leaveFrom()),
    classes: getClasses().map((c) => ({
      id: c.id, name: c.name, days: c.days, start: c.start, place: point(c.place),
      from: c.from || null, until: c.until || null, skip: c.skip || [],
    })),
  };
  return post('/api/push/plan', { device: deviceId(), plan });
}

export function openReminders() {
  dialog?.remove();
  dialog = document.createElement('dialog');
  dialog.className = 'class-dialog';
  dialog.setAttribute('aria-label', 'Leave-now reminders');
  const title = document.createElement('h2');
  title.textContent = '🔔 Leave-now reminders';
  const intro = document.createElement('p');
  intro.className = 'share-note notify-intro';
  intro.textContent =
    'HooMaps buzzes your phone 2 minutes before you need to leave for each class, with the bus to take. ' +
    'To do that, your classes (days, times, buildings) are saved on our server under a random ID for this phone. ' +
    'Never your name or location. Turning reminders off deletes them.';
  const body = document.createElement('div');
  body.className = 'notify-body';
  const msg = document.createElement('div');
  msg.className = 'report-msg';
  msg.setAttribute('role', 'status');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'link-button';
  close.textContent = 'Close';
  close.addEventListener('click', () => dialog.close());
  const foot = document.createElement('div');
  foot.className = 'class-actions';
  foot.append(close);

  dialog.append(title, intro, body, msg, foot);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  render(body, msg);
}

async function render(body, msg) {
  body.replaceChildren();
  const say = (text) => {
    const p = document.createElement('p');
    p.className = 'notify-state';
    p.textContent = text;
    body.append(p);
  };

  if (isIPhone && !isInstalled()) {
    return say('On iPhone, notifications only work in the Home Screen app: tap Share → Add to Home Screen, then open HooMaps from its icon and come back here. (Needs iOS 16.4 or newer.)');
  }
  if (!supported()) return say('This browser can’t show notifications. Try Chrome or Safari, or the Home Screen app.');
  if (import.meta.env.DEV) return say('Notifications only work in the built app (the live site or npm run preview), not in npm run dev.');
  if (Notification.permission === 'denied') {
    return say(isIPhone
      ? 'Notifications are blocked for HooMaps. Turn them on in Settings → Notifications → HooMaps, then try again.'
      : 'Notifications are blocked for this site. Allow them in the browser’s site settings (the icon left of the address), then try again.');
  }

  say('Checking…');
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const server = await getJson('/api/push/key');
  body.replaceChildren();
  if (!server?.key) return say('Notifications aren’t set up on the server yet.');

  if (existing && Notification.permission === 'granted') {
    // Make sure the server still has this phone (e.g. after turning off on another visit).
    if (!server.on) await post('/api/push/subscribe', { device: deviceId(), subscription: existing.toJSON() });
    writeStorage(ON_KEY, '1');
    await syncPlan(); // (also covers phones that turned reminders on before classes were synced)
    say('✅ Reminders are on for this phone.');
    body.append(leaveFromField(msg), coverage());
    const actions = document.createElement('div');
    actions.className = 'popup-actions';
    const test = button('Send a test notification', 'star-button share-primary');
    test.addEventListener('click', async () => {
      test.disabled = true;
      showMsg(msg, 'Sending…');
      const result = await post('/api/push/test', { device: deviceId() });
      test.disabled = false;
      showMsg(msg, result.ok ? 'Sent! It should pop up in a few seconds (lock your phone to see it on the lock screen).' : result.error, !result.ok);
    });
    const off = button('Turn off', 'star-button');
    off.addEventListener('click', async () => {
      off.disabled = true;
      await existing.unsubscribe().catch(() => {});
      await post('/api/push/unsubscribe', { device: deviceId() });
      writeStorage(ON_KEY, '');
      showMsg(msg, 'Reminders are off. Your classes were deleted from our server.');
      render(body, msg);
    });
    actions.append(test, off);
    body.append(actions);
    return;
  }

  say('Reminders are off.');
  const on = button('Turn on reminders', 'star-button share-primary');
  on.addEventListener('click', async () => {
    on.disabled = true;
    // Ask first, straight from the tap (iPhone only allows the question then).
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showMsg(msg, 'Notifications weren’t allowed, so reminders can’t work.', true);
      return render(body, msg);
    }
    showMsg(msg, 'Turning on…');
    try {
      const sub = (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(server.key) }));
      const result = await post('/api/push/subscribe', { device: deviceId(), subscription: sub.toJSON() });
      if (!result.ok) throw new Error(result.error);
      writeStorage(ON_KEY, '1');
      await syncPlan();
      showMsg(msg, 'Done! Pick where you usually leave from, then send a test.');
    } catch (err) {
      console.error(err);
      showMsg(msg, err.message || 'Couldn’t turn on notifications. Try again?', true);
    }
    render(body, msg);
  });
  body.append(on);
}

// "Usually leave from": where your first class of the day starts from.
function leaveFromField(msg) {
  const wrap = document.createElement('label');
  wrap.className = 'class-field';
  wrap.textContent = 'Usually leave from (for your first class each day)';
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'start-input';
  input.placeholder = 'e.g. Gooch/Dillard, or your street';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = leaveFrom()?.name || '';
  const list = document.createElement('ul');
  list.id = 'leave-from-suggestions';
  list.className = 'suggestions inline';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Place suggestions');
  list.hidden = true;
  wrap.append(input);
  attachAutocomplete({
    input,
    listEl: list,
    onPick: async (p) => {
      input.value = p.name;
      writeStorage(FROM_KEY, JSON.stringify({ name: p.name, location: p.location }));
      const result = await syncPlan();
      showMsg(msg, result?.ok ? `Saved: your first class each day starts from ${p.name}.` : result?.error || 'Saved on this phone.', Boolean(result && !result.ok));
    },
    onError: (text) => showMsg(msg, text, true),
  });
  const box = document.createElement('div');
  box.append(wrap, list);
  return box;
}

// "Reminders for your 5 classes" (+ a warning without "usually leave from").
function coverage() {
  const p = document.createElement('p');
  p.className = 'share-note';
  const n = getClasses().length;
  p.textContent = !n
    ? 'Add your classes (＋ Add class or 📥 Import from SIS) to get reminders.'
    : `Reminders for your ${n} class${n === 1 ? '' : 'es'}, 2 min before you need to leave.` +
      (leaveFrom() ? '' : ' Without a “usually leave from” place, there’s no reminder for your first class of the day.');
  return p;
}

// The server's public key, from the "base64url" text form to the bytes the browser wants.
function keyBytes(base64url) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function button(text, className) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = text;
  return btn;
}

function showMsg(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
}

async function getJson(path) {
  try {
    const res = await fetch(path, { headers: { 'X-Device': deviceId() } });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

async function post(path, body) {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...data } : { ok: false, error: data.error || 'Couldn’t do that. Try again?' };
  } catch {
    return { ok: false, error: 'No connection. Try again?' };
  }
}

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Private browsing: works for this visit only.
  }
}
