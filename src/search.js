// Search + trip options.
// 1. Type a destination in the top bar (UVA nicknames work) and pick it.
// 2. We find where you are (phone location) or let you type a starting place.
// 3. Our server (/api/trip) compares: walk → wait → ride → walk on each UVA route (live),
//    CAT city buses (Google's schedules), UVA ↔ CAT transfers on long trips,
//    and walking the whole way. Sorted by arrival time.

import { currentTheme } from './theme.js';
import { liveLocation } from './locate.js';
import { busWarnings, KINDS } from './reports.js';
import { parkedInfo, parkedDetail } from './live.js';
import { attachAutocomplete } from './autocomplete.js';
import { starButton, isPlaceSaved, togglePlace, setHomePanelVisible } from './favorites.js';

const TRIP_REFRESH_MS = 30_000; // buses move: refresh the options while the card is open
const GROUNDS = { lat: 38.0336, lng: -78.508 };
const NEAR_GROUNDS_M = 8_000; // trips must start within ~5 miles of Grounds

const form = document.getElementById('search');
const input = document.getElementById('search-input');
const clearBtn = document.getElementById('search-clear');
const listEl = document.getElementById('suggestions');
const cardEl = document.getElementById('place-card');

let ctx; // borrowed from main.js: map, AdvancedMarkerElement, decodePath, demo, openStopById, showPopup, focusRoute, unfocusRoute
let destination = null; // { name, address, location }
let origin = null; // { name, location, isGps }
let destPin = null;
let youDot = null;
let tripLine = null; // a CAT trip's path, drawn when you tap it
let catStops = []; // markers for a CAT trip's get-on and get-off stops
let walkLegs = []; // dotted walking paths to/from the bus stops of the tapped option
let walkLegsCount = 0; // ignore walking paths that arrive after another option was tapped
let refreshTimer = null;
let tripCount = 0; // ignore answers to old trip requests that arrive late
let arriveByMs = null; // "Arrive by" time (clock ms), or null for "Leave now"
let arriveMode = false; // is the card currently showing arrive-by results?
let lastTrip = null; // the latest /api/trip answer (for Share my ETA)
let tappedBus = null; // the UVA option you tapped last (for Share my ETA)
let autoPick = false; // opened from a reminder: tap the best option once the answer arrives
let quietPick = false; // that tap shouldn't also open the stop's popup (the card already says it)
let lastFit = null; // the points the map was last fitted to (to slide back after a popup closes)
let minimized = false; // card shrunk to one line (▾ button, or automatically while a popup is open on a phone)
let autoMinimized = false; // shrunk because a popup opened: grow back when it closes
let mainBox;

/**
 * Called once by main.js after the map is ready.
 * context = { map, AdvancedMarkerElement, decodePath, demo, openStopById(id), showPopup(content, marker) }
 */
export function initSearch(context) {
  ctx = context;

  mainBox = attachAutocomplete({
    input,
    listEl,
    onPick: chooseDestination,
    onError: (msg) => showCard({ error: msg }),
  });

  input.addEventListener('input', () => (clearBtn.hidden = !input.value));
  form.addEventListener('submit', (e) => e.preventDefault());
  clearBtn.addEventListener('click', () => {
    clearAll();
    input.focus();
  });
  ctx.map.addListener('click', () => mainBox.close()); // tapping the map closes suggestions

  // Back in the app after a while: refresh right away (buses have moved).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && destination && origin) loadTrip();
  });
}

// ---------- Destination + starting point ----------

// Used by the favorites panel: go straight to trip options for a saved place.
export function openPlace(place) {
  mainBox.clear();
  input.value = place.name;
  clearBtn.hidden = false;
  chooseDestination(place);
}

// Used by "My classes": a trip that arrives by a time (ms), from a given place or (from = null)
// from where you are now.
export function openTripTo(place, { arriveBy = null, from = null, pickBest = false } = {}) {
  if (destination) clearAll();
  autoPick = pickBest;
  if (from) {
    origin = { name: from.name, location: from.location, isGps: false };
    youDot = placeMarker(youDot, 'start-pin', from.location, 'Starting point', 19);
  } else if (origin && !origin.isGps) {
    origin = null; // forget a typed starting place: use your location
  }
  // Set before openPlace so the first lookup is already "Arrive by" (no wasted Leave-now lookup).
  arriveByMs = arriveBy && arriveBy > Date.now() + 60_000 ? arriveBy : null;
  openPlace(place);
}

function chooseDestination(place) {
  // A bus stop from search: show it on the map with its arrival times (and report buttons).
  if (place.stopId != null) {
    const name = place.name;
    if (destination) clearAll(); // close any open trip card first
    input.value = name;
    clearBtn.hidden = false;
    if (ctx.openStopById(place.stopId)) return;
    // Its routes aren't running now: plan a trip to it like any other place instead.
  }
  clearBtn.hidden = false;
  destination = place;
  minimized = false;
  autoMinimized = false;
  destPin = placeMarker(destPin, 'place-pin', place.location, 'Your destination', 20);
  if (origin) {
    youDot.map = ctx.map; // a typed starting place kept from the last search
    return loadTrip();
  }

  showCard({ status: 'Finding your location…' });
  findMe();
}

// Ask the phone where we are. Falls back to "Starting from" if it can't or won't.
// Two asks at once: a ROUGH location (Wi-Fi / cell towers, usually under 1 s) plans the trip
// right away; a PRECISE one (GPS, can take 2-10 s, longer indoors and on laptops) quietly
// replaces it if it lands far enough away to change which stop is best.
const ROUGH_OK_M = 500; // a rough fix this accurate (or better) is good enough to start with
const PRECISE_MOVE_M = 150; // re-plan only if the precise fix is this far from the rough one
let findCount = 0;

function findMe() {
  // The live blue dot is on: use it right away instead of asking the phone again.
  const live = liveLocation();
  if (live && metersBetween(live, GROUNDS) <= NEAR_GROUNDS_M) {
    return setOrigin({ name: 'My location', location: live, isGps: true });
  }
  if (!navigator.geolocation) return askForStart('Your browser can’t share location.');

  const myFind = ++findCount;
  const stillWanted = () => myFind === findCount && destination; // card not closed / searched again
  let started = false; // a trip has been planned from one of the two fixes
  let preciseDone = false;
  const toPoint = (pos) => ({ lat: pos.coords.latitude, lng: pos.coords.longitude });

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (!stillWanted() || started) return;
      const here = toPoint(pos);
      // Too fuzzy (e.g. one cell tower) or seemingly far away: wait for the precise answer.
      if (pos.coords.accuracy > ROUGH_OK_M || metersBetween(here, GROUNDS) > NEAR_GROUNDS_M) return;
      started = true;
      setOrigin({ name: 'My location', location: here, isGps: true });
    },
    (err) => {
      // Only matters if the precise ask also can't help (it reports its own failure).
      if (stillWanted() && !started && preciseDone && err.code === err.PERMISSION_DENIED) {
        askForStart('Location is turned off for this site.');
      }
    },
    { enableHighAccuracy: false, timeout: 4_000, maximumAge: 120_000 },
  );

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      preciseDone = true;
      if (!stillWanted()) return;
      const here = toPoint(pos);
      const nearGrounds = metersBetween(here, GROUNDS) <= NEAR_GROUNDS_M;
      if (!started) {
        if (!nearGrounds) return askForStart('You’re not near Grounds right now.');
        started = true;
        return setOrigin({ name: 'My location', location: here, isGps: true });
      }
      // Already planned from the rough fix: update only if it really moved (and we're still
      // starting from "My location", not a place typed in since).
      if (!nearGrounds || !origin?.isGps || metersBetween(here, origin.location) < PRECISE_MOVE_M) return;
      origin.location = here;
      youDot = placeMarker(youDot, 'you-dot', here, 'You are here', 19);
      loadTrip({ refit: false });
    },
    (err) => {
      preciseDone = true;
      if (!stillWanted() || started) return; // the rough fix already did the job
      askForStart(err.code === err.PERMISSION_DENIED ? 'Location is turned off for this site.' : 'Couldn’t find your location.');
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
  );
}

function setOrigin(place) {
  origin = place;
  youDot = placeMarker(youDot, place.isGps ? 'you-dot' : 'start-pin', place.location, place.isGps ? 'You are here' : 'Starting point', 19);
  loadTrip();
}

function placeMarker(marker, className, position, title, zIndex) {
  if (!marker) {
    const el = document.createElement('div');
    marker = new ctx.AdvancedMarkerElement({ content: el, zIndex, title });
  }
  marker.content.className = className;
  marker.title = title;
  marker.position = position;
  marker.map = ctx.map;
  return marker;
}

// ---------- Trip options ----------

async function loadTrip({ refit = true } = {}) {
  clearTimeout(refreshTimer);
  if (!destination || !origin) return;
  // Walking with the live dot on: each refresh starts from where you are now.
  if (origin.isGps) {
    const live = liveLocation();
    if (live) origin.location = live;
  }
  const myTrip = ++tripCount;
  if (refit) {
    showCard({ status: 'Checking UVA and CAT buses…' });
    hideTripLine();
  }

  const pt = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  let data;
  try {
    if (arriveByMs && arriveByMs < Date.now() - 60_000) arriveByMs = null; // that time has passed
    const when = (arriveByMs ? `&arriveBy=${arriveByMs}` : '') + (prefer !== 'fastest' ? `&prefer=${prefer}` : '');
    const res = await fetch(`/api/trip?from=${pt(origin.location)}&to=${pt(destination.location)}${when}${ctx.demo ? '&demo=1' : ''}`);
    data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || 'Trip failed'), { friendly: data.error });
  } catch (err) {
    if (myTrip !== tripCount) return;
    console.error(err);
    showCard({ error: err.friendly || 'Trip times are unavailable right now.' });
    scheduleRefresh();
    return;
  }
  if (myTrip !== tripCount) return;

  lastTrip = data;
  showCard({ trip: data });
  if (refit) {
    // When walking is the best way, draw the walking path right away.
    const top = data.options?.[0];
    if (top?.type === 'walk') showWalkLine(top);
    fitMap([origin.location, destination.location]);
  }
  // From a leave-now reminder: show the best option right away (its route, stop and walk).
  if (autoPick && data.tooLate && arriveByMs) {
    // Even walking won't make it on time: the reminder already said "leave now", so skip
    // the red message and show the fastest way now (autoPick stays on for that answer).
    arriveByMs = null;
    return loadTrip();
  }
  if (autoPick) {
    autoPick = false;
    quietPick = true;
    cardEl.querySelector('.trip-option')?.click();
    quietPick = false;
  }
  scheduleRefresh();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!document.hidden) loadTrip({ refit: false });
  }, TRIP_REFRESH_MS);
}

// After a popup closes: show the whole trip again (only while the trip card is open).
export function refitTrip() {
  if (destination && lastFit && !cardEl.hidden) fitMap(lastFit);
}

function fitMap(points) {
  lastFit = points;
  const bounds = new google.maps.LatLngBounds();
  for (const p of points) bounds.extend(p);
  ctx.map.fitBounds(bounds, { top: 130, bottom: cardEl.offsetHeight + 50, left: 40, right: 40 });
  google.maps.event.addListenerOnce(ctx.map, 'idle', () => {
    if (ctx.map.getZoom() > 18) ctx.map.setZoom(18); // don't zoom in absurdly close
  });
}

// ---------- The card at the bottom ----------

function showCard({ status, error, trip }) {
  cardEl.replaceChildren();

  // The title and ✕ stay pinned at the top while the card scrolls.
  const head = document.createElement('div');
  head.className = 'card-head';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'card-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '✕';
  close.addEventListener('click', clearAll);
  // ▾ shrinks the card to one line (title + best option); tap that line or ▴ to grow it back.
  const min = document.createElement('button');
  min.type = 'button';
  min.className = 'card-min';
  min.addEventListener('click', (e) => {
    e.stopPropagation();
    setMinimized(!minimized);
  });
  head.addEventListener('click', (e) => {
    if (minimized && !e.target.closest('.card-close')) setMinimized(false);
  });
  const summary = document.createElement('p');
  summary.className = 'card-summary';
  summary.textContent = status || error || (trip ? tripSummary(trip) : '');
  head.append(summary, min, close);
  cardEl.append(head);

  if (destination) {
    const title = document.createElement('h2');
    title.textContent = destination.name;
    head.prepend(title);
    if (destination.id && destination.location) {
      const place = destination;
      const actions = document.createElement('div');
      actions.className = 'popup-actions card-actions';
      actions.append(starButton({ isSaved: () => isPlaceSaved(place.id), toggle: () => togglePlace(place), saveLabel: 'Save place' }));
      // Going to a bus stop: one tap to see its live arrival times (the trip stays open).
      const stopId = /^stop:(\d+)$/.exec(String(place.id))?.[1];
      if (stopId) {
        const times = document.createElement('button');
        times.type = 'button';
        times.className = 'star-button';
        times.textContent = '🕒 Arrival times';
        times.setAttribute('aria-label', `Arrival times at ${place.name}`);
        times.addEventListener('click', () => {
          if (!ctx.openStopById(Number(stopId))) times.textContent = '🕒 No buses here right now';
        });
        actions.append(times);
      } else {
        // Any other place: live times at the closest bus stop (within ~10 min walk).
        const near = place.location && ctx.nearestStop(place.location);
        if (near && near.meters <= 800) {
          const times = document.createElement('button');
          times.type = 'button';
          times.className = 'star-button';
          times.textContent = '🕒 Times at nearest stop';
          times.title = near.name;
          times.setAttribute('aria-label', `Arrival times at the nearest stop, ${near.name}`);
          times.addEventListener('click', () => ctx.openStopById(near.id));
          actions.append(times);
        }
      }
      cardEl.append(actions);
    }
    if (destination.address) {
      const addr = document.createElement('p');
      addr.className = 'card-address';
      addr.textContent = destination.address;
      cardEl.append(addr);
    }
  }

  if (origin) cardEl.append(fromRow(), whenRow(), preferRow());

  const body = document.createElement('div');
  body.className = 'card-body';
  body.setAttribute('aria-live', 'polite');
  if (status) body.textContent = status;
  else if (error) body.textContent = error;
  else if (trip) fillOptions(body, trip);
  cardEl.append(body);

  cardEl.hidden = false;
  applyMinimized();
  document.body.classList.add('has-place-card');
  setHomePanelVisible(false);
}

// One line for the shrunk card: "🚌 Gold Line · arrive 3:59 PM".
function tripSummary(trip) {
  const o = trip.options?.[0];
  if (!o) return '';
  const name = o.type === 'walk' ? '🚶 Walk' : `🚌 ${optionName(o).replace(/^the /, '')}`;
  return `${name} · ${arriveAt(o.totalSeconds, o).textContent}`;
}

function applyMinimized() {
  cardEl.classList.toggle('minimized', minimized);
  const min = cardEl.querySelector('.card-min');
  if (min) {
    min.textContent = minimized ? '▴' : '▾';
    min.setAttribute('aria-label', minimized ? 'Show trip details' : 'Shrink trip card');
    min.setAttribute('aria-expanded', String(!minimized));
  }
  if (minimized) cardEl.scrollTop = 0;
}

function setMinimized(on) {
  minimized = on;
  autoMinimized = false;
  applyMinimized();
}

// main.js: a stop/bus popup opened. On phones, shrink the trip card so the popup has room.
export function shrinkForPopup() {
  if (!destination || cardEl.hidden || minimized) return;
  if (!window.matchMedia('(pointer: coarse)').matches) return;
  minimized = true;
  autoMinimized = true;
  applyMinimized();
}

// main.js: the popup closed. Grow the card back (if we shrank it), then show the whole trip again.
export function afterPopupClosed() {
  if (autoMinimized) {
    minimized = false;
    autoMinimized = false;
    applyMinimized();
  }
  refitTrip();
}

// "When: Leave now | Arrive by [9:30]"
function whenRow() {
  const row = document.createElement('div');
  row.className = 'when-row';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'When');

  const label = document.createElement('span');
  label.textContent = 'When:';
  const now = segButton('Leave now', !arriveByMs, () => {
    arriveByMs = null;
    loadTrip();
  });
  const by = segButton('Arrive by', Boolean(arriveByMs), () => {
    if (!arriveByMs) arriveByMs = defaultArriveBy();
    loadTrip();
  });
  row.append(label, now, by);

  if (arriveByMs) {
    const time = document.createElement('input');
    time.type = 'time';
    time.className = 'when-time';
    time.setAttribute('aria-label', 'Arrive by time');
    const d = new Date(arriveByMs);
    time.value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    time.addEventListener('change', () => {
      if (!time.value) return;
      arriveByMs = nextTimeAt(time.value);
      loadTrip();
    });
    row.append(time);
  }
  return row;
}

// "Prefer: ⚡ Fastest | 🚶 Less walking | 🔁 Fewer transfers" (remembered on this phone)
const PREFER_KEY = 'hoos-riding.prefer';
let prefer = (() => {
  try {
    const v = localStorage.getItem(PREFER_KEY);
    return v === 'walk' || v === 'transfers' ? v : 'fastest';
  } catch {
    return 'fastest';
  }
})();

function preferRow() {
  const row = document.createElement('div');
  row.className = 'when-row prefer-row';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Prefer');
  const label = document.createElement('span');
  label.textContent = 'Prefer:';
  row.append(label);
  for (const [value, text] of [['fastest', '⚡ Fastest'], ['walk', '🚶 Less walking'], ['transfers', '🔁 Fewer transfers']]) {
    row.append(segButton(text, prefer === value, () => {
      prefer = value;
      try {
        if (value === 'fastest') localStorage.removeItem(PREFER_KEY);
        else localStorage.setItem(PREFER_KEY, value);
      } catch {
        // storage blocked: works for this visit
      }
      loadTrip({ refit: false });
    }));
  }
  return row;
}

function segButton(text, pressed, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'seg-button';
  btn.textContent = text;
  btn.setAttribute('aria-pressed', String(pressed));
  btn.addEventListener('click', onClick);
  return btn;
}

// 30+ minutes from now, rounded up to the next 5 minutes.
function defaultArriveBy() {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return d.getTime();
}

// "09:30" -> the next time the clock shows 9:30 (today, or tomorrow if it's already passed).
function nextTimeAt(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() < Date.now() - 60_000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// "From: My location · Change"
function fromRow() {
  const row = document.createElement('div');
  row.className = 'card-from';
  const label = document.createElement('span');
  label.textContent = `From: ${origin.name}`;
  const change = document.createElement('button');
  change.type = 'button';
  change.className = 'link-button';
  change.textContent = 'Change';
  change.addEventListener('click', () => askForStart());
  row.append(label, change);
  return row;
}

// Shows a "Starting from" box in the card, with its own suggestions.
function askForStart(reason) {
  clearTimeout(refreshTimer);
  showCard({ status: '' });
  const body = cardEl.querySelector('.card-body');
  body.replaceChildren();

  if (reason) {
    const why = document.createElement('p');
    why.className = 'card-note';
    why.textContent = `${reason} Where are you starting from?`;
    body.append(why);
  }

  const startInput = document.createElement('input');
  startInput.type = 'search';
  startInput.className = 'start-input';
  startInput.placeholder = 'Starting from… e.g. Runk';
  startInput.setAttribute('aria-label', 'Starting place');
  startInput.enterKeyHint = 'search';
  startInput.autocomplete = 'off';
  startInput.spellcheck = false;

  const startList = document.createElement('ul');
  startList.id = 'start-suggestions';
  startList.className = 'suggestions inline';
  startList.setAttribute('role', 'listbox');
  startList.setAttribute('aria-label', 'Starting place suggestions');
  startList.hidden = true;

  body.append(startInput, startList);

  if (navigator.geolocation && !origin?.isGps) {
    const useGps = document.createElement('button');
    useGps.type = 'button';
    useGps.className = 'link-button';
    useGps.textContent = '📍 Use my location';
    useGps.addEventListener('click', () => {
      showCard({ status: 'Finding your location…' });
      findMe();
    });
    body.append(useGps);
  }

  attachAutocomplete({
    input: startInput,
    listEl: startList,
    onPick: (place) => setOrigin({ name: place.name, location: place.location, isGps: false }),
    onError: (msg) => {
      startInput.value = '';
      startInput.placeholder = msg;
    },
  });
  startInput.focus();
}

function fillOptions(body, trip) {
  const { options } = trip;
  const walk = options.find((o) => o.type === 'walk');
  const buses = options.filter((o) => o.type !== 'walk');
  arriveMode = Boolean(trip.arriveBy);

  if (arriveMode && trip.tooLate) {
    const msg = document.createElement('p');
    msg.className = 'leave-banner late';
    msg.textContent = `Even walking won’t make it by ${clockAt(trip.arriveBy)}. Leave now!`;
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'link-button';
    back.textContent = 'Show the fastest way now';
    back.addEventListener('click', () => {
      arriveByMs = null;
      loadTrip();
    });
    body.append(msg, back);
    return;
  }

  if (arriveMode && options.length) {
    const top = options[0];
    const banner = document.createElement('p');
    banner.className = 'leave-banner';
    banner.textContent = top.leaveBySeconds <= 60
      ? `⏰ Leave now to arrive by ${clockAt(trip.arriveBy)}`
      : top.leaveBySeconds > 3 * 3600
        ? `⏰ Leave by ${clock(top.leaveBySeconds)}`
        : `⏰ Leave in ${mins(top.leaveBySeconds)} (by ${clock(top.leaveBySeconds)})`;
    body.append(banner);
  }

  if (!arriveMode && walk && walk.totalSeconds < 120) {
    body.textContent = 'You’re basically there already! 🎉';
    return;
  }

  const verdict = verdictLine(trip, walk);
  if (verdict) body.append(verdict);

  const heading = document.createElement('h3');
  heading.textContent = 'Ways to get there';
  body.append(heading);

  const draw = { walk: walkOption, bus: busOption, cat: catOption, transfer: transferOption };
  // Skip kinds of options this version of the app doesn't know yet (e.g. right after an
  // update, when the server is newer than the page), and never let one bad option blank the list.
  options.filter((o) => draw[o.type]).forEach((o, i) => {
    try {
      body.append(draw[o.type](o, i === 0));
    } catch (err) {
      console.error('Could not show a trip option', o, err);
    }
  });

  // (When a bus exists but walking is faster, the verdict line already says so.)
  const addNote = (text) => {
    const note = document.createElement('p');
    note.className = 'card-note';
    note.textContent = text;
    body.append(note);
  };
  if (!buses.length && !trip.busesRunning) addNote('No UVA buses are running right now.');
  else if (!buses.length && trip.noNearbyStops) {
    // "Closest UVA stop to Downtown Mall: Grady Ave @ 10½ St, ~23 min walk."
    const stops = trip.closestStops || [];
    if (!stops.length) addNote('No UVA bus stops are close enough to this trip.');
    for (const s of stops) {
      const end = s.side === 'from' ? (origin?.isGps ? 'you' : origin?.name) : destination?.name;
      const note = document.createElement('p');
      note.className = 'card-note';
      // The stop name opens its popup: shows where it is, its times, and 🧭 Directions.
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'link-button';
      link.textContent = s.name;
      link.setAttribute('aria-label', `Show ${s.name} on the map`);
      link.addEventListener('click', () => {
        if (!ctx.openStopById(s.id)) link.textContent = `${s.name} (no buses there right now)`;
      });
      note.append(`Closest UVA stop${end ? ` to ${end}` : ''}: `, link, `, ~${mins(s.walkSeconds)} walk.`);
      body.append(note);
    }
  }
  // No CAT option and Google's next CAT bus is over an hour away (e.g. CAT doesn't run Sundays).
  if (trip.catNextAt) addNote(`No CAT buses until ${dayClock(trip.catNextAt)}.`);

  if (trip.catStatus === 'limit' || trip.catStatus === 'error') {
    const note = document.createElement('p');
    note.className = 'card-note';
    note.textContent = trip.catStatus === 'limit' ? 'CAT times are resting for today.' : 'CAT times are unavailable right now.';
    body.append(note);
  }
}

// Saving less than this isn't worth the bus: the verdict says to walk.
const CLOSE_CALL_S = 2 * 60;

// The one-line answer at the top of the card: bus or walk?
function verdictLine(trip, walk) {
  const best = trip.options[0];
  if (!best) return null;
  // "Less walking" / "Fewer transfers" with a bus on top: say why it's first.
  const pref = trip.prefer || 'fastest';
  if (pref !== 'fastest' && best.type !== 'walk') {
    // How much later than the fastest way (arrive later, or leave earlier in arrive-by mode).
    const slower = arriveMode
      ? Math.max(...trip.options.map((o) => o.leaveBySeconds)) - best.leaveBySeconds
      : best.totalSeconds - Math.min(...trip.options.map((o) => o.totalSeconds));
    const note = slower >= 60 ? ` (${arriveMode ? 'leave' : 'arrives'} ${mins(slower)} ${arriveMode ? 'earlier' : 'later'} than the fastest way)` : '';
    const text = pref === 'walk'
      ? `🚶 Least walking: ${optionName(best)}, ${mins(best.footSeconds)} on foot${note}`
      : best.transfers === 0
        ? `🚌 One bus, no transfers: ${optionName(best)}${note}`
        : `🔁 Fewest transfers: ${optionName(best)} (${best.transfers} transfer${best.transfers > 1 ? 's' : ''})${note}`;
    const el = document.createElement('p');
    el.className = 'verdict verdict-bus';
    el.textContent = text;
    return el;
  }
  let walkWins;
  let text;
  if (best.type === 'walk') {
    walkWins = true;
    const others = trip.options.length > 1;
    text = arriveMode
      ? '🚶 Walking is your best bet'
      : others ? '🚶 Walking is faster right now' : '🚶 Walking is your best bet right now';
  } else if (!walk) {
    // Arrive-by mode, and walking can't make it in time.
    walkWins = false;
    text = `🚌 Take ${optionName(best)}: walking won’t make it in time`;
  } else {
    const gain = arriveMode ? best.leaveBySeconds - walk.leaveBySeconds : walk.totalSeconds - best.totalSeconds;
    walkWins = gain < CLOSE_CALL_S;
    if (walkWins) {
      text = arriveMode ? '🚶 Walking works just as well' : '🚶 Walking is just as fast right now';
    } else if (arriveMode) {
      text = `🚌 Take ${optionName(best)}: you can leave ${mins(gain)} later than walking`;
    } else {
      const firstWait = best.type === 'transfer' ? null : best.waitSeconds;
      const hurry = firstWait !== null && firstWait !== undefined && firstWait < 2 * 60 ? ' Head to the stop now.' : '';
      text = `🚌 Take ${optionName(best)}: saves ${mins(gain)} over walking.${hurry}`;
    }
  }
  const el = document.createElement('p');
  el.className = `verdict ${walkWins ? 'verdict-walk' : 'verdict-bus'}`;
  el.textContent = text;
  return el;
}

// "the Gold Line", "CAT 7", "the Purple Line → CAT 7"
export function optionName(o) {
  const cat = (lines) => `CAT ${lines.map((l) => l.name).join(' → ')}`;
  if (o.type === 'bus') return `the ${o.route.name.trim()}`;
  if (o.type === 'cat') return cat(o.lines);
  if (o.type === 'transfer') {
    return o.direction === 'uva-cat' ? `the ${o.uva.route.name.trim()} → ${cat(o.cat.lines)}` : `${cat(o.cat.lines)} → the ${o.uva.route.name.trim()}`;
  }
  return 'the bus';
}

function busOption(o, fastest) {
  const btn = optionButton(fastest);

  const top = document.createElement('div');
  top.className = 'option-top';
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = o.route.color;
  const name = document.createElement('span');
  name.className = 'option-name';
  name.textContent = o.route.name;
  top.append(swatch, name, badge('UVA', 'badge-uva'), arriveAt(o.totalSeconds, o));

  const steps = document.createElement('div');
  steps.className = 'option-steps';
  const ride = `${o.rideEstimated ? 'about ' : ''}${mins(o.rideSeconds)} ride`;
  if (arriveMode && o.estimated) {
    steps.textContent = `${arrivePrefix(o)}about ${mins(o.totalSeconds)} · walk ${mins(o.walkToStopSeconds)} → bus every ~${mins(o.headwaySeconds)} → ${ride} → walk ${mins(o.walkFromStopSeconds)} (estimate: buses that far ahead aren’t live yet)`;
  } else if (arriveMode) {
    steps.textContent = `${arrivePrefix(o)}walk ${mins(o.walkToStopSeconds)} → bus at ${clock(o.busInSeconds)} → ${ride} → walk ${mins(o.walkFromStopSeconds)}`;
  } else if (o.estimated) {
    // No live time from TransLoc yet (e.g. bus waiting at the start of its route): worst-case estimate.
    steps.textContent = `about ${mins(o.totalSeconds)} total · walk ${mins(o.walkToStopSeconds)} → bus every ~${mins(o.headwaySeconds)} (no live time yet) → ${ride} → walk ${mins(o.walkFromStopSeconds)}`;
  } else {
    steps.textContent = `${mins(o.totalSeconds)} total · walk ${mins(o.walkToStopSeconds)} → bus in ${mins(o.waitSeconds + o.walkToStopSeconds)} → ${ride} → walk ${mins(o.walkFromStopSeconds)}`;
  }

  const where = document.createElement('div');
  where.className = 'option-where';
  where.textContent = `Get on at ${o.board.name} · off at ${o.alight.name}`;

  btn.append(top, steps, where);
  // Rider reports about THIS bus (e.g. "Riders say: packed"), so you can wait for the next one.
  const warnings = o.vehicleId != null ? busWarnings(o.vehicleId) : [];
  if (warnings.length) {
    const warn = document.createElement('div');
    warn.className = 'option-warning';
    warn.textContent = `⚠️ Riders say: ${warnings.map((w) => KINDS[w.kind]?.label.toLowerCase() || w.kind).join(', ')}`;
    btn.append(warn);
  }
  // This bus is parked (layover / driver break): its countdown may be frozen.
  const parked = parkedInfo(o.vehicleId);
  if (parked) {
    const note = document.createElement('div');
    note.className = 'option-warning';
    note.textContent = `⏸ This bus is parked (${parkedDetail(parked)}), so it may leave later than shown.`;
    btn.append(note);
  }
  btn.setAttribute(
    'aria-label',
    `${o.route.name}, ${mins(o.totalSeconds)} total. Walk ${mins(o.walkToStopSeconds)} to ${o.board.name}, ` +
      `bus comes in ${mins(o.waitSeconds + o.walkToStopSeconds)}, ${ride} to ${o.alight.name}, then walk ${mins(o.walkFromStopSeconds)}. Show the stop.`,
  );
  btn.addEventListener('click', () => {
    tappedBus = o;
    hideTripLine();
    showWalkLegs([[origin.location, o.board], [o.alight, destination.location]]);
    ctx.focusRoute(o.route.id); // show just this route's line, stops and buses
    fitMap([origin.location, o.board, o.alight, destination.location]);
    if (!quietPick) google.maps.event.addListenerOnce(ctx.map, 'idle', () => ctx.openStopById(o.board.id));
  });
  return btn;
}

// A CAT (city bus) option. Times are from CAT's schedule (via Google), not live.
function catOption(o, fastest) {
  const btn = optionButton(fastest);
  const lineNames = o.lines.map((l) => `Route ${l.name}`).join(' then ');

  const top = document.createElement('div');
  top.className = 'option-top';
  const pills = document.createElement('span');
  pills.className = 'cat-lines';
  for (const l of o.lines) {
    const pill = document.createElement('span');
    pill.className = 'cat-line';
    pill.style.background = l.color;
    pill.style.color = readableOn(l.color);
    pill.textContent = l.name;
    pills.append(pill);
  }
  const name = document.createElement('span');
  name.className = 'option-name';
  name.textContent = o.lines.length > 1 ? 'CAT (1 transfer)' : o.lines[0].headsign || 'CAT bus';
  top.append(pills, name, badge('CAT', 'badge-cat'), badge('Free', 'badge-free'), arriveAt(o.totalSeconds, o));

  const steps = document.createElement('div');
  steps.className = 'option-steps';
  const busAt = clock(o.busInSeconds ?? o.walkToStopSeconds + o.waitSeconds);
  steps.textContent = `${arriveMode ? arrivePrefix(o) : `${mins(o.totalSeconds)} total · `}walk ${mins(o.walkToStopSeconds)} → bus at ${busAt} (scheduled) → ${mins(o.rideSeconds)} ride → walk ${mins(o.walkFromStopSeconds)}`;

  const where = document.createElement('div');
  where.className = 'option-where';
  where.textContent = `Get on at ${o.board.name} · off at ${o.alight.name}`;

  btn.append(top, steps, where);
  btn.setAttribute(
    'aria-label',
    `CAT ${lineNames}, free, ${mins(o.totalSeconds)} total. Walk ${mins(o.walkToStopSeconds)} to ${o.board.name}, ` +
      `scheduled bus at ${busAt}, ${mins(o.rideSeconds)} ride to ${o.alight.name}, then walk ${mins(o.walkFromStopSeconds)}. Show the route.`,
  );
  btn.addEventListener('click', () => {
    ctx.focusNone(); // just this CAT trip on the map, no UVA routes
    showTripLine(o.polyline, o.lines[0].color);
    showWalkLegs([[origin.location, o.board], [o.alight, destination.location]]);
    const pts = [origin.location, destination.location];
    for (const stop of [o.board, o.alight]) if (Number.isFinite(stop.lat)) pts.push(stop);
    fitMap(pts);
    if (!Number.isFinite(o.board.lat)) return;

    const on = catStopMarker(o.board, o.lines[0].color, 'Get on here');
    if (Number.isFinite(o.alight.lat)) catStopMarker(o.alight, o.lines.at(-1).color, 'Get off here');
    const popup = catStopPopup(o, busAt);
    if (!quietPick) google.maps.event.addListenerOnce(ctx.map, 'idle', () => ctx.showPopup(popup, on));
    on.addEventListener('gmp-click', () => ctx.showPopup(catStopPopup(o, busAt), on));
  });
  return btn;
}

// A square marker (UVA stops are round) for a CAT stop.
function catStopMarker(stop, color, title) {
  const el = document.createElement('div');
  el.className = 'cat-stop';
  el.style.borderColor = color;
  const marker = new ctx.AdvancedMarkerElement({
    position: { lat: stop.lat, lng: stop.lng },
    content: el,
    title: `${title}: ${stop.name}`,
    gmpClickable: true,
    zIndex: 15,
    map: ctx.map,
  });
  catStops.push(marker);
  return marker;
}

function catStopPopup(o, busAt, heading = 'Get on here (CAT)') {
  const box = document.createElement('div');
  box.className = 'stop-popup';
  const label = document.createElement('div');
  label.className = 'popup-label';
  label.textContent = heading;
  const title = document.createElement('h2');
  title.textContent = o.board.name;
  const when = document.createElement('div');
  when.className = 'arrival';
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = o.lines[0].color;
  const name = document.createElement('span');
  name.className = 'arrival-route';
  name.textContent = `Route ${o.lines[0].name}${o.lines[0].headsign ? ` · ${o.lines[0].headsign}` : ''}`;
  const time = document.createElement('span');
  time.className = 'arrival-times';
  time.textContent = busAt;
  when.append(swatch, name, time);
  const note = document.createElement('div');
  note.className = 'popup-note';
  note.textContent = o.lines.length > 1
    ? `Scheduled time · free · then change to Route ${o.lines.slice(1).map((l) => l.name).join(', ')}`
    : 'Scheduled time · free';
  box.append(label, title, when, note);
  return box;
}

// UVA bus + CAT bus in one trip (or CAT then UVA), changing at a transfer stop.
function transferOption(o, fastest) {
  const btn = optionButton(fastest);
  const { uva, cat } = o;
  const catName = cat.lines.map((l) => l.name).join(' → ');
  const uvaFirst = o.direction === 'uva-cat';

  const top = document.createElement('div');
  top.className = 'option-top';
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = uva.route.color;
  const pills = document.createElement('span');
  pills.className = 'cat-lines';
  for (const l of cat.lines) {
    const pill = document.createElement('span');
    pill.className = 'cat-line';
    pill.style.background = l.color;
    pill.style.color = readableOn(l.color);
    pill.textContent = l.name;
    pills.append(pill);
  }
  const name = document.createElement('span');
  name.className = 'option-name';
  name.textContent = uvaFirst ? `${uva.route.name} → CAT ${catName}` : `CAT ${catName} → ${uva.route.name}`;
  top.append(...(uvaFirst ? [swatch, pills] : [pills, swatch]), name, badge('UVA', 'badge-uva'), badge('CAT', 'badge-cat'), arriveAt(o.totalSeconds, o));

  const catAt = clock(cat.busInSeconds);
  const uvaRide = `${uva.rideEstimated ? 'about ' : ''}${mins(uva.rideSeconds)} ride`;
  // When the UVA bus is: "in 4 min" (now), "at 9:15" (arrive by), or "every ~8 min" (estimate).
  const uvaWhen = uva.busInSeconds === undefined || (uva.estimated && !arriveMode)
    ? `every ~${mins(uva.headwaySeconds)}${uva.estimated && !arriveMode ? ' (no live time yet)' : ''}`
    : arriveMode ? `at ${clock(uva.busInSeconds)}` : `in ${mins(uva.busInSeconds)}`;
  const lead = arriveMode ? arrivePrefix(o) : `${mins(o.totalSeconds)} total · `;
  const change = `change: walk ${mins(uvaFirst ? uva.walkFromStopSeconds + cat.walkToStopSeconds : cat.walkFromStopSeconds + uva.walkToStopSeconds)}, wait ${mins(o.changeWaitSeconds)}`;
  const steps = document.createElement('div');
  steps.className = 'option-steps';
  steps.textContent = uvaFirst
    ? `${lead}walk ${mins(uva.walkToStopSeconds)} → ${uva.route.name} ${uvaWhen} → ${uvaRide} → ${change} → CAT ${catName} at ${catAt} (scheduled) → ${mins(cat.rideSeconds)} ride → walk ${mins(cat.walkFromStopSeconds)}`
    : `${lead}walk ${mins(cat.walkToStopSeconds)} → CAT ${catName} at ${catAt} (scheduled) → ${mins(cat.rideSeconds)} ride → ${change} → ${uva.route.name} ${uvaWhen} → ${uvaRide} → walk ${mins(uva.walkFromStopSeconds)}`;

  const where = document.createElement('div');
  where.className = 'option-where';
  where.textContent = uvaFirst
    ? `Get on at ${uva.board.name} · off at ${uva.alight.name} · CAT from ${cat.board.name} · off at ${cat.alight.name}`
    : `Get on at ${cat.board.name} · off at ${cat.alight.name} · UVA from ${uva.board.name} · off at ${uva.alight.name}`;

  btn.append(top, steps, where);
  btn.setAttribute('aria-label', `Transfer trip, ${mins(o.totalSeconds)} total. ${steps.textContent}. ${where.textContent}. Show it on the map.`);

  btn.addEventListener('click', () => {
    ctx.focusRoute(uva.route.id); // show just the UVA route used
    showTripLine(cat.polyline, cat.lines[0].color);
    showWalkLegs(uvaFirst
      ? [[origin.location, uva.board], [cat.alight, destination.location]]
      : [[origin.location, cat.board], [uva.alight, destination.location]]);
    const pts = [origin.location, destination.location, uva.board, uva.alight];
    for (const stop of [cat.board, cat.alight]) if (Number.isFinite(stop.lat)) pts.push(stop);
    fitMap(pts);

    const catOn = Number.isFinite(cat.board.lat)
      ? catStopMarker(cat.board, cat.lines[0].color, uvaFirst ? 'Change here: get on CAT' : 'Get on here')
      : null;
    if (Number.isFinite(cat.alight.lat)) catStopMarker(cat.alight, cat.lines.at(-1).color, 'Get off CAT here');
    const popup = () => catStopPopup(cat, catAt, uvaFirst ? 'Change here: get on CAT' : 'Get on here (CAT)');
    if (catOn) catOn.addEventListener('gmp-click', () => ctx.showPopup(popup(), catOn));

    // Open the popup for where the trip STARTS: the UVA stop (live arrivals) or the CAT stop.
    if (!quietPick) google.maps.event.addListenerOnce(ctx.map, 'idle', () => {
      if (uvaFirst) ctx.openStopById(uva.board.id);
      else if (catOn) ctx.showPopup(popup(), catOn);
    });
  });
  return btn;
}

// The walking path from Google (dotted navy). Nothing is drawn if Google didn't send one
// (e.g. its daily cap was reached and the walk time is an estimate).
function showWalkLine(o) {
  showTripLine(o.polyline, currentTheme() === 'dark' ? '#8ab4f8' : '#232d4b', 'dots');
}

// style 'dash' = CAT bus (dashed), 'dots' = walking (dotted). Neither looks like a UVA route line.
function showTripLine(encoded, color, style = 'dash') {
  hideTripLine();
  if (!encoded) return;
  const icon = style === 'dots'
    ? { icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: color, fillOpacity: 1, strokeOpacity: 0, scale: 3.5 }, offset: '0', repeat: '12px' }
    : { icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.9, strokeWeight: 4, scale: 3 }, offset: '0', repeat: '14px' };
  tripLine = new google.maps.Polyline({
    path: ctx.decodePath(encoded),
    strokeColor: color,
    strokeOpacity: 0,
    icons: [icon],
    clickable: false,
    zIndex: 5,
    map: ctx.map,
  });
}

// The walks of a bus option (to the stop, from the stop) as dotted lines. Real walking paths
// from Google (through our server: cached a day, counted in our daily cap); if that fails,
// a straight dotted line so you still see where to walk. Very short walks are skipped.
const WALK_LEG_MIN_M = 40;

function showWalkLegs(legs) {
  const myTap = walkLegsCount;
  const color = currentTheme() === 'dark' ? '#8ab4f8' : '#232d4b';
  const pt = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  for (const [a, b] of legs) {
    if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) continue;
    if (metersBetween(a, b) < WALK_LEG_MIN_M) continue;
    fetch(`/api/walk?from=${pt(a)}&to=${pt(b)}`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((walk) => {
        if (myTap !== walkLegsCount) return; // another option was tapped meanwhile
        const path = walk?.polyline ? ctx.decodePath(walk.polyline) : [a, b];
        walkLegs.push(dottedLine(path, color));
      });
  }
}

function dottedLine(path, color) {
  return new google.maps.Polyline({
    path,
    strokeOpacity: 0,
    icons: [{ icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: color, fillOpacity: 1, strokeOpacity: 0, scale: 3 }, offset: '0', repeat: '11px' }],
    clickable: false,
    zIndex: 6,
    map: ctx.map,
  });
}

function hideTripLine() {
  if (tripLine) tripLine.setMap(null);
  tripLine = null;
  walkLegsCount++;
  for (const l of walkLegs) l.setMap(null);
  walkLegs = [];
  for (const m of catStops) m.map = null;
  catStops = [];
}

function badge(text, className) {
  const el = document.createElement('span');
  el.className = `badge ${className}`;
  el.textContent = text;
  return el;
}

// Navy text on light colors, white text on dark colors.
function readableOn(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#232d4b' : '#ffffff';
}

function walkOption(o, fastest) {
  const btn = optionButton(fastest);
  const top = document.createElement('div');
  top.className = 'option-top';
  const icon = document.createElement('span');
  icon.className = 'option-icon';
  icon.textContent = '🚶';
  icon.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'option-name';
  name.textContent = 'Walk';
  top.append(icon, name, arriveAt(o.totalSeconds, o));

  const steps = document.createElement('div');
  steps.className = 'option-steps';
  steps.textContent = `${arrivePrefix(o)}${o.estimated ? 'about ' : ''}${mins(o.totalSeconds)} the whole way`;
  btn.append(top, steps);
  btn.addEventListener('click', () => {
    showWalkLine(o);
    ctx.focusNone(); // just the walking path on the map
    fitMap([origin.location, destination.location]);
  });
  return btn;
}

function optionButton(fastest) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'trip-option';
  if (fastest) {
    btn.classList.add('fastest');
    const tag = document.createElement('span');
    tag.className = 'fastest-tag';
    tag.textContent = prefer === 'walk' ? '⭐ Least walking'
      : prefer === 'transfers' ? '⭐ Fewest transfers'
      : arriveMode ? '⭐ Leave latest' : '⭐ Fastest';
    btn.append(tag);
  }
  return btn;
}

// Right side of an option: "arrive 9:42 AM" (leave now) or "leave by 9:12 AM" (arrive by).
function arriveAt(totalSeconds, o) {
  const el = document.createElement('span');
  el.className = 'option-arrive';
  el.textContent = arriveMode && o?.leaveBySeconds !== undefined
    ? `leave by ${clock(Math.max(0, o.leaveBySeconds))}`
    : `arrive ${clock(totalSeconds)}`;
  return el;
}

// In arrive-by mode, the step line starts with when you'll actually get there.
const arrivePrefix = (o) => (arriveMode && o.arriveSeconds !== undefined ? `arrive ${clock(o.arriveSeconds)} · ` : '');

// "9:42 AM", or "tomorrow 9:42 AM" when it's not today.
function clockAt(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `tomorrow ${time}`;
}

// "9:42 AM", "tomorrow 9:42 AM", or "Mon 9:42 AM" further ahead.
function dayClock(ms) {
  const d = new Date(ms);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 1) return clockAt(ms);
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

// "9:42 AM", this many seconds from now.
const clock = (secondsFromNow) => clockAt(Date.now() + secondsFromNow * 1000);

const mins = (seconds) => {
  if (seconds < 60) return '<1 min';
  const total = Math.round(seconds / 60);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
};

function metersBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(h));
}

// Share my ETA: where you'll get off this route, from the open trip card (or null).
// → { stopId, destName (null if the destination IS the stop), walkAfterS }
export function tripPlanFor(routeId) {
  if (!destination || !lastTrip) return null;
  const o = tappedBus?.route.id === routeId
    ? tappedBus
    : (lastTrip.options || []).find((x) => x.type === 'bus' && x.route.id === routeId);
  if (!o) return null;
  const isTheStop = String(destination.id || '') === `stop:${o.alight.id}`;
  return { stopId: o.alight.id, destName: isTheStop ? null : destination.name, walkAfterS: isTheStop ? 0 : o.walkFromStopSeconds };
}

// ---------- Reset ----------

function clearAll() {
  clearTimeout(refreshTimer);
  tripCount++;
  mainBox.clear();
  clearBtn.hidden = true;
  cardEl.hidden = true;
  document.body.classList.remove('has-place-card');
  setHomePanelVisible(true);
  if (destPin) destPin.map = null;
  if (youDot) youDot.map = null;
  hideTripLine();
  ctx.unfocusRoute();
  destination = null;
  lastTrip = null;
  tappedBus = null;
  autoPick = false;
  lastFit = null;
  arriveByMs = null;
  minimized = false;
  autoMinimized = false;
  // Keep a typed starting place for the next search, but re-check GPS each time.
  if (origin?.isGps) origin = null;
}
