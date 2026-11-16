// Favorites + home panel.
// Save stops (☆ in a stop's popup) and places (☆ in the trip card). They're kept ON THIS
// DEVICE only (browser storage), never sent to our server. The panel at the bottom shows
// your stops' next buses (live, every 15s) and one-tap trips to your places.

import { initClasses, classesSection, hasClasses } from './classes.js';

const STORE_KEY = 'hoos-riding.favorites';
const COLLAPSED_KEY = 'hoos-riding.favorites-collapsed';
const MAX_EACH = 6;
const REFRESH_MS = 15_000;
const TIMES_PER_ROUTE = 2;

const panel = document.getElementById('home-panel');

let ctx; // from main.js: demo, openStopById(id), openPlace(place), panTo(latLng)
let favs = load();
let collapsed = loadFlag(COLLAPSED_KEY);
let editing = false;
let refreshTimer = null;
const arrivals = new Map(); // stopId -> { data, fetchedAt } | { error: true }
const listeners = new Set();

export function initFavorites(context) {
  ctx = context;
  initClasses({ onChange: render, demo: ctx.demo, openTripTo: ctx.openTripTo, optionName: ctx.optionName });
  render();
  refreshArrivals();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshArrivals();
  });
  // Keep the status pill above the panel, whatever its height.
  new ResizeObserver(() => {
    document.body.style.setProperty('--home-panel-h', `${panel.hidden ? 0 : panel.offsetHeight}px`);
  }).observe(panel);
}

// Other parts of the app (stop popup, trip card) redraw their ☆ when favorites change.
export const onFavoritesChange = (fn) => listeners.add(fn);

// ---------- Saving ----------

export const isStopSaved = (id) => favs.stops.some((s) => s.id === id);
export const isPlaceSaved = (id) => favs.places.some((p) => p.id === id);

/** Returns true if now saved, false if removed, or a message if the list is full. */
export function toggleStop(stop) {
  if (isStopSaved(stop.id)) {
    favs.stops = favs.stops.filter((s) => s.id !== stop.id);
  } else {
    if (favs.stops.length >= MAX_EACH) return `You can save up to ${MAX_EACH} stops. Remove one first.`;
    favs.stops.push({ id: stop.id, name: stop.name, lat: stop.lat, lng: stop.lng });
  }
  changed();
  refreshArrivals();
  return isStopSaved(stop.id);
}

export function togglePlace(place) {
  if (isPlaceSaved(place.id)) {
    favs.places = favs.places.filter((p) => p.id !== place.id);
  } else {
    if (favs.places.length >= MAX_EACH) return `You can save up to ${MAX_EACH} places. Remove one first.`;
    favs.places.push({ id: place.id, name: place.name, address: place.address || '', location: place.location });
  }
  changed();
  return isPlaceSaved(place.id);
}

function changed() {
  save();
  if (!favs.stops.length && !favs.places.length && !hasClasses()) editing = false;
  render();
  for (const fn of listeners) fn();
}

// ---------- Live times for saved stops ----------

async function refreshArrivals() {
  clearTimeout(refreshTimer);
  if (!ctx || document.hidden || collapsed || panel.hidden || !favs.stops.length) return;

  await Promise.all(
    favs.stops.map(async (s) => {
      try {
        const res = await fetch(`/api/stops/${s.id}/arrivals${ctx.demo ? '?demo=1' : ''}`);
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `status ${res.status}`);
        arrivals.set(s.id, { data: data.arrivals, fetchedAt: data.fetchedAt });
      } catch (err) {
        console.error('Favorite stop arrivals', s.id, err);
        arrivals.set(s.id, { error: true });
      }
    }),
  );
  render();
  refreshTimer = setTimeout(refreshArrivals, REFRESH_MS);
}

// ---------- The panel ----------

// Hidden while a search/trip card is open (search.js calls this).
export function setHomePanelVisible(visible) {
  panel.hidden = !visible;
  if (visible) refreshArrivals();
  else clearTimeout(refreshTimer);
}

function render() {
  panel.replaceChildren();
  panel.classList.toggle('collapsed', collapsed);
  const hasAny = favs.stops.length || favs.places.length;
  const canEdit = hasAny || hasClasses();
  if (!canEdit) editing = false;

  // Header: "★ Favorites" (tap to open/close) + Edit
  const header = document.createElement('div');
  header.className = 'home-header';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'home-toggle';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.textContent = `★ Favorites ${collapsed ? '▴' : '▾'}`;
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    saveFlag(COLLAPSED_KEY, collapsed);
    render();
    refreshArrivals();
  });
  header.append(toggle);
  if (canEdit && !collapsed) {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'link-button';
    edit.textContent = editing ? 'Done' : 'Edit';
    edit.addEventListener('click', () => {
      editing = !editing;
      render();
    });
    header.append(edit);
  }
  panel.append(header);
  if (collapsed) return;

  panel.append(sectionTitle(editing ? 'Your classes' : 'Today’s classes'));
  panel.append(classesSection({ editing }));

  if (!hasAny) {
    const tip = document.createElement('p');
    tip.className = 'card-note';
    tip.textContent = 'Tap a bus stop on the map and choose ☆ Save stop, or search a place and tap ☆ Save place. They’ll show up here.';
    panel.append(tip);
    return;
  }

  if (favs.stops.length) {
    panel.append(sectionTitle('Your stops'));
    for (const s of favs.stops) panel.append(stopRow(s));
  }
  if (favs.places.length) {
    panel.append(sectionTitle('Your places'));
    const chips = document.createElement('div');
    chips.className = 'place-chips';
    for (const p of favs.places) chips.append(placeChip(p));
    panel.append(chips);
  }
}

function sectionTitle(text) {
  const h = document.createElement('h3');
  h.className = 'home-title';
  h.textContent = text;
  return h;
}

function stopRow(stop) {
  const row = document.createElement('div');
  row.className = 'fav-stop';

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'fav-stop-main';
  const name = document.createElement('div');
  name.className = 'fav-stop-name';
  name.textContent = stop.name;
  const times = document.createElement('div');
  times.className = 'fav-stop-times';
  fillTimes(times, arrivals.get(stop.id));
  main.append(name, times);
  main.setAttribute('aria-label', `${stop.name}. ${times.textContent}. Show on map.`);
  main.addEventListener('click', () => {
    if (!ctx.openStopById(stop.id) && Number.isFinite(stop.lat)) ctx.panTo({ lat: stop.lat, lng: stop.lng });
  });
  row.append(main);
  if (editing) row.append(removeButton(`Remove ${stop.name}`, () => toggleStop(stop)));
  else row.append(directionsButton(stop, { compact: true }));
  return row;
}

// "🧭 Directions": plan a trip from where you are to this bus stop (like searching a place).
export function directionsButton(stop, { compact = false } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = compact ? 'directions-button compact' : 'star-button directions-button';
  btn.textContent = compact ? '🧭' : '🧭 Directions';
  btn.setAttribute('aria-label', `Directions to ${stop.name}`);
  btn.addEventListener('click', () => {
    if (!Number.isFinite(stop.lat)) return;
    ctx.openPlace({
      id: `stop:${stop.id}`,
      name: stop.name,
      address: 'UVA bus stop',
      location: { lat: stop.lat, lng: stop.lng },
      source: 'stop',
    });
  });
  return btn;
}

function fillTimes(el, entry) {
  if (!entry) {
    el.textContent = 'Loading…';
    return;
  }
  if (entry.error) {
    el.textContent = 'Times unavailable right now';
    return;
  }
  const ageSecs = (Date.now() - entry.fetchedAt) / 1000;
  const routes = entry.data.filter((a) => a.times.length).slice(0, 3);
  if (!routes.length) {
    el.textContent = 'No buses expected soon';
    return;
  }
  for (const a of routes) {
    const chip = document.createElement('span');
    chip.className = 'fav-time';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = a.color;
    const label = document.createElement('span');
    const next = a.times.slice(0, TIMES_PER_ROUTE).map((t) => wait(t.seconds - ageSecs, t.arriving)).join(' · ');
    label.textContent = `${a.routeName} ${next}`;
    chip.append(swatch, label);
    el.append(chip);
  }
}

const wait = (seconds, arriving) => (arriving || seconds < 60 ? 'Now' : `${Math.round(seconds / 60)} min`);

function placeChip(place) {
  const wrap = document.createElement('span');
  wrap.className = 'place-chip-wrap';
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip place-chip';
  chip.textContent = `📍 ${place.name}`;
  chip.setAttribute('aria-label', `Trip to ${place.name}`);
  chip.addEventListener('click', () => ctx.openPlace(place));
  wrap.append(chip);
  if (editing) wrap.append(removeButton(`Remove ${place.name}`, () => togglePlace(place)));
  return wrap;
}

function removeButton(label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fav-remove';
  btn.setAttribute('aria-label', label);
  btn.textContent = '✕';
  btn.addEventListener('click', onClick);
  return btn;
}

// ---------- A ☆ button other parts of the app can use ----------

/** A "☆ Save …" / "★ Saved" button that keeps itself up to date. */
export function starButton({ isSaved, toggle, saveLabel }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'star-button';
  const draw = () => {
    const saved = isSaved();
    btn.textContent = saved ? '★ Saved' : `☆ ${saveLabel}`;
    btn.setAttribute('aria-pressed', String(saved));
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const result = toggle();
    if (typeof result === 'string') {
      btn.textContent = result;
      setTimeout(draw, 3_000);
    } else draw();
  });
  draw();
  const update = () => {
    if (!btn.isConnected) return listeners.delete(update); // its popup/card was closed
    draw();
  };
  setTimeout(() => onFavoritesChange(update), 0); // after it's been added to the page
  return btn;
}

// ---------- Device storage (may be blocked in private browsing) ----------

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORE_KEY));
    return { stops: Array.isArray(data?.stops) ? data.stops : [], places: Array.isArray(data?.places) ? data.places : [] };
  } catch {
    return { stops: [], places: [] };
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(favs));
  } catch {
    // Private browsing can block storage: favorites still work until the app closes.
  }
}

function loadFlag(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function saveFlag(key, value) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // ignore
  }
}
