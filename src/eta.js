// "Share my ETA".
// Rider: tap the bus you're on → 📤 Share my ETA → pick where you get off → send the link.
// Friend: opens the link (hoomaps…/?eta=abc) and sees that bus moving, your stop, and when you'll get there.
// Privacy: the link only knows the BUS (public, from UVA's tracker) and the stop. Never your phone's location.
// The server keeps the share (server/shares.js) and ends it 15 min after the bus reaches the stop.

import { deviceId } from './reports.js';
import { parkedInfo, parkedDetail } from './live.js';

const SAVED_KEY = 'hoos-riding.share'; // the link this phone is sharing now (so it can stop it)
const NAME_KEY = 'hoos-riding.share-name'; // the name you typed last time
const VIEW_POLL_MS = 5_000;

export const ETA_ID = new URLSearchParams(location.search).get('eta');

let ctx; // from main.js: map, AdvancedMarkerElement, demo, routeStops, tripPlanFor, focusRoute, unfocusRoute, highlightBus, setHomePanelVisible
const api = (path) => (ctx.demo ? `${path}?demo=1` : path);

export function initEta(context) {
  ctx = context;
  if (ETA_ID) startViewer(ETA_ID);
}

// ---------- Rider side: the section inside a bus popup ----------

export function shareSection(vehicleId, routeId) {
  const box = document.createElement('div');
  box.className = 'share-box';
  const saved = loadSaved();
  if (saved && saved.vehicleId === vehicleId) renderSharing(box, saved, vehicleId, routeId);
  else renderStart(box, vehicleId, routeId);
  return box;
}

function renderStart(box, vehicleId, routeId) {
  const btn = button('📤 Share my ETA', 'star-button');
  btn.setAttribute('aria-label', 'Share my ETA: send friends a link to follow this bus to your stop');
  btn.addEventListener('click', () => renderForm(box, vehicleId, routeId));
  box.replaceChildren(btn);
}

function renderForm(box, vehicleId, routeId) {
  const stops = ctx.routeStops(routeId);
  const plan = ctx.tripPlanFor(routeId); // from an open trip card on this route, if any

  const heading = document.createElement('div');
  heading.className = 'popup-label';
  heading.textContent = 'Share my ETA';

  const stopLabel = document.createElement('label');
  stopLabel.className = 'share-field';
  stopLabel.textContent = 'Where do you get off?';
  const select = document.createElement('select');
  select.append(new Option('Choose your stop', ''));
  for (const s of stops) select.append(new Option(s.name, String(s.id)));
  if (plan && stops.some((s) => s.id === plan.stopId)) select.value = String(plan.stopId);
  stopLabel.append(select);

  const after = document.createElement('div');
  after.className = 'share-note';
  const showAfter = () => {
    const usePlan = plan?.destName && select.value === String(plan.stopId);
    after.textContent = usePlan ? `Then walking to ${plan.destName}.` : '';
    after.hidden = !usePlan;
  };
  select.addEventListener('change', showAfter);
  showAfter();

  const nameLabel = document.createElement('label');
  nameLabel.className = 'share-field';
  nameLabel.textContent = 'Your name (optional)';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 20;
  nameInput.autocomplete = 'given-name';
  nameInput.placeholder = 'e.g. Sam';
  nameInput.value = readStorage(NAME_KEY) || '';
  nameLabel.append(nameInput);

  const privacy = document.createElement('div');
  privacy.className = 'share-note';
  privacy.textContent = 'Friends see this bus, your stop and when you’ll get there. Never your location. The link ends 15 min after you arrive.';

  const msg = document.createElement('div');
  msg.className = 'report-msg';
  msg.setAttribute('role', 'status');

  const actions = document.createElement('div');
  actions.className = 'popup-actions';
  const create = button('Create link', 'star-button share-primary');
  const cancel = button('Cancel', 'star-button');
  cancel.addEventListener('click', () => renderStart(box, vehicleId, routeId));
  actions.append(create, cancel);

  create.addEventListener('click', async () => {
    const stopId = Number(select.value);
    if (!stopId) {
      showMsg(msg, 'Pick the stop where you’ll get off.', true);
      select.focus();
      return;
    }
    const usePlan = plan && plan.stopId === stopId;
    const name = nameInput.value.trim();
    writeStorage(NAME_KEY, name);
    create.disabled = cancel.disabled = true;
    showMsg(msg, 'Making your link…');
    const result = await post(api('/api/shares'), {
      vehicleId,
      stopId,
      destName: usePlan ? plan.destName : null,
      walkAfterS: usePlan ? plan.walkAfterS : 0,
      name,
      device: deviceId(),
    });
    create.disabled = cancel.disabled = false;
    if (!result.ok) return showMsg(msg, result.error, true);

    const stopName = stops.find((s) => s.id === stopId)?.name || 'my stop';
    const saved = {
      id: result.data.id,
      token: result.data.token,
      vehicleId,
      url: `${location.origin}/?eta=${encodeURIComponent(result.data.id)}${ctx.demo ? '&demo' : ''}`,
      text: `Follow my bus on HooMaps: I’m on the ${ctx.routeName(routeId)} to ${usePlan && plan.destName ? plan.destName : stopName}.`,
      endsAt: result.data.endsAt,
    };
    saveSaved(saved);
    renderSharing(box, saved, vehicleId, routeId, { justMade: true });
  });

  box.replaceChildren(heading, stopLabel, after, nameLabel, privacy, actions, msg);
  select.focus();
}

function renderSharing(box, saved, vehicleId, routeId, { justMade = false } = {}) {
  const line = document.createElement('div');
  line.className = 'share-on';
  line.textContent = '✅ Sharing your ETA';
  const note = document.createElement('div');
  note.className = 'share-note';
  note.textContent = 'Anyone with the link can follow this bus until 15 min after it reaches your stop.';

  const link = document.createElement('input');
  link.type = 'text';
  link.readOnly = true;
  link.className = 'share-link';
  link.value = saved.url;
  link.setAttribute('aria-label', 'Your ETA link');
  link.addEventListener('focus', () => link.select());

  const msg = document.createElement('div');
  msg.className = 'report-msg';
  msg.setAttribute('role', 'status');

  const actions = document.createElement('div');
  actions.className = 'popup-actions';
  const send = button(navigator.share ? '📤 Send link' : '📋 Copy link', 'star-button share-primary');
  send.addEventListener('click', async () => {
    const how = await sendLink(saved);
    if (how === 'copied') showMsg(msg, 'Link copied. Paste it in a text!');
    else if (how === 'failed') showMsg(msg, 'Couldn’t share automatically. Copy the link above.', true);
  });
  const stop = button('Stop sharing', 'star-button');
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    await post(`/api/shares/${encodeURIComponent(saved.id)}/stop`, { token: saved.token });
    clearSaved();
    renderStart(box, vehicleId, routeId);
  });
  actions.append(send, stop);
  box.replaceChildren(line, note, link, actions, msg);

  // Open the phone's share sheet right away (some phones only allow it on a fresh tap: then use the button).
  if (justMade) sendLink(saved).then((how) => how === 'copied' && showMsg(msg, 'Link copied. Paste it in a text!'));

  // The server may have ended it already (restart, or 15 min after arrival): go back to the button.
  fetch(api(`/api/shares/${encodeURIComponent(saved.id)}`))
    .then((res) => {
      if (res.status === 404) {
        clearSaved();
        renderStart(box, vehicleId, routeId);
      }
    })
    .catch(() => {});
}

// Phone share sheet if there is one, else copy. Returns 'shared' | 'cancelled' | 'copied' | 'failed'.
async function sendLink(saved) {
  if (navigator.share) {
    try {
      await navigator.share({ title: 'My bus ETA', text: saved.text, url: saved.url });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
      // NotAllowedError: not a fresh tap. Fall through to copying.
    }
  }
  try {
    await navigator.clipboard.writeText(saved.url);
    return 'copied';
  } catch {
    return 'failed';
  }
}

// ---------- Friend side: the ?eta= view ----------

let viewTimer = null;
let viewing = null; // the share id while the ETA card is open
let stopPin = null;
let fitted = false;
let lastData = null;

function startViewer(id) {
  viewing = id;
  document.body.classList.add('has-eta-card');
  ctx.setHomePanelVisible(false);
  renderViewer({ loading: true });
  pollViewer();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && viewing) pollViewer();
  });
}

async function pollViewer() {
  clearTimeout(viewTimer);
  if (!viewing) return;
  try {
    const res = await fetch(api(`/api/shares/${encodeURIComponent(viewing)}`));
    if (res.status === 404) {
      lastData = null;
      renderViewer({ ended: true });
      ctx.highlightBus(null);
      ctx.unfocusRoute();
      if (stopPin) stopPin.map = null;
      return; // nothing more to follow
    }
    if (!res.ok) throw new Error(`Server answered ${res.status}`);
    const data = await res.json();
    lastData = { ...data, receivedAt: Date.now() };
    showOnMap(data);
    renderViewer({ data: lastData });
  } catch (err) {
    console.error(err);
    renderViewer({ data: lastData, offline: true });
  }
  if (!document.hidden && viewing) viewTimer = setTimeout(pollViewer, VIEW_POLL_MS);
}

function showOnMap(data) {
  ctx.focusRoute(data.route.id); // just this route's line, stops and buses
  ctx.highlightBus(data.vehicleId);
  if (!stopPin) {
    const el = document.createElement('div');
    el.className = 'place-pin';
    stopPin = new ctx.AdvancedMarkerElement({ content: el, zIndex: 20, title: data.stop.name });
  }
  stopPin.position = { lat: data.stop.lat, lng: data.stop.lng };
  stopPin.map = ctx.map;
  if (!fitted) {
    fitted = true;
    const bounds = new google.maps.LatLngBounds();
    bounds.extend(data.bus);
    bounds.extend(data.stop);
    const card = document.getElementById('eta-card');
    ctx.map.fitBounds(bounds, { top: 130, bottom: (card?.offsetHeight || 200) + 50, left: 40, right: 40 });
    google.maps.event.addListenerOnce(ctx.map, 'idle', () => {
      if (ctx.map.getZoom() > 17) ctx.map.setZoom(17);
    });
  }
}

function renderViewer({ loading, ended, data, offline }) {
  const card = document.getElementById('eta-card');
  card.replaceChildren();
  card.hidden = false;

  const head = document.createElement('div');
  head.className = 'card-head';
  const title = document.createElement('h2');
  const close = button('✕', 'card-close');
  close.setAttribute('aria-label', 'Close and explore HooMaps');
  close.addEventListener('click', stopViewer);
  head.append(title, close);
  card.append(head);

  const body = document.createElement('div');
  body.className = 'card-body';
  body.setAttribute('aria-live', 'polite');
  card.append(body);

  if (loading) {
    title.textContent = 'Shared bus ETA';
    body.textContent = 'Loading…';
    return;
  }
  if (ended || !data) {
    title.textContent = 'This ETA link has ended';
    const why = document.createElement('p');
    why.className = 'eta-sub';
    why.textContent = offline
      ? 'Can’t reach HooMaps. Retrying…'
      : 'Links stop 15 minutes after the bus reaches the stop (or when the rider stops sharing).';
    body.append(why, exploreButton());
    return;
  }

  const who = data.name || 'Your friend';
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = data.route.color;
  title.append(swatch, ` ${who} is on the ${data.route.name}`);

  // The server's countdown, kept ticking between updates.
  const sinceS = (Date.now() - data.receivedAt) / 1000;
  const eta = data.etaSeconds === null ? null : Math.max(0, data.etaSeconds - sinceS);
  const walk = data.walkAfterS || 0;

  const big = document.createElement('p');
  big.className = 'eta-big';
  const sub = document.createElement('p');
  sub.className = 'eta-sub';

  if (data.status === 'arrived') {
    big.textContent = `✅ The bus reached ${data.stop.name} at ${clockAt(data.arrivedAt)}.`;
    if (data.destName) sub.textContent = `${who} is walking to ${data.destName}: there about ${clockAt(data.arrivedAt + walk * 1000)}.`;
  } else if (data.status === 'lost') {
    big.textContent = 'The bus stopped sending its location.';
    sub.textContent = `We can’t follow it anymore. It was heading to ${data.stop.name}.`;
  } else if (eta === null) {
    big.textContent = `Heading to ${data.stop.name}`;
    sub.textContent = 'No live arrival time right now. Watch the bus on the map.';
  } else {
    big.textContent = `Gets to ${data.stop.name} at ${clockAt(Date.now() + eta * 1000)}`;
    const when = eta < 60 ? 'Arriving now' : `in ${mins(eta)}`;
    sub.textContent = data.destName
      ? `${when}, then about ${mins(walk)} walk to ${data.destName} (there about ${clockAt(Date.now() + (eta + walk) * 1000)}).`
      : `${when}.`;
  }
  body.append(big);
  if (sub.textContent) body.append(sub);

  const parked = data.status === 'riding' ? parkedInfo(data.vehicleId) : null;
  if (parked) {
    const note = document.createElement('p');
    note.className = 'live-note';
    note.textContent = `⏸ The bus has been parked ${parkedDetail(parked)}, so it may take longer.`;
    body.append(note);
  }

  const foot = document.createElement('p');
  foot.className = 'eta-foot';
  foot.textContent = offline
    ? 'Can’t reach HooMaps. Retrying…'
    : `Bus ${data.busName} · live from UVA’s bus tracker. ${who}’s phone location is never shared.`;
  body.append(foot, exploreButton());
}

function exploreButton() {
  const btn = button('Explore HooMaps', 'star-button');
  btn.addEventListener('click', stopViewer);
  return btn;
}

// Close the ETA card and use the app normally.
function stopViewer() {
  viewing = null;
  clearTimeout(viewTimer);
  const url = new URL(location.href);
  url.searchParams.delete('eta');
  history.replaceState(null, '', url);
  document.getElementById('eta-card').hidden = true;
  document.body.classList.remove('has-eta-card');
  if (stopPin) stopPin.map = null;
  ctx.highlightBus(null);
  ctx.unfocusRoute();
  ctx.setHomePanelVisible(true);
}

// ---------- Small helpers ----------

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

async function post(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, data } : { ok: false, error: data.error || 'Couldn’t do that. Try again?' };
  } catch {
    return { ok: false, error: 'No connection. Try again?' };
  }
}

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_KEY) || 'null');
    if (saved && saved.endsAt > Date.now()) return saved;
  } catch {
    // Storage blocked or broken: treat as not sharing.
  }
  return null;
}
const saveSaved = (saved) => writeStorage(SAVED_KEY, JSON.stringify(saved));
const clearSaved = () => writeStorage(SAVED_KEY, '');

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

function clockAt(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function mins(seconds) {
  if (seconds < 60) return '<1 min';
  const total = Math.round(seconds / 60);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
