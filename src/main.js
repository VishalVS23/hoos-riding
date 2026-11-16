// Hoos Riding: the map page.
// Loads Google Maps, draws the running routes and their stops, asks our server
// for bus positions every 5 seconds, and slides each bus smoothly to its new spot.
// Tap a stop to see arrival times. Use the buttons at the top to show one route.
// The search bar lives in search.js.

import { showInstallTipIfNeeded } from './install-tip.js';
import { initSearch, openPlace, openTripTo, optionName, tripPlanFor, shrinkForPopup, afterPopupClosed } from './search.js';
import { initFavorites, starButton, isStopSaved, toggleStop, directionsButton, setHomePanelVisible } from './favorites.js';
import { initEta, shareSection } from './eta.js';
import { openReminderTrip } from './classes.js';
import { currentTheme, initThemeToggle, initCavToggle } from './theme.js';
import { initLocate } from './locate.js';
import { setParked, parkedInfo, parkedDetail } from './live.js';
import {
  initReports, setReports, busReports, busWarnings, stopReports, reportList, reportButtons,
  deviceId, BUS_KINDS, STOP_KINDS,
} from './reports.js';

const GROUNDS_CENTER = { lat: 38.0336, lng: -78.508 };
const POLL_MS = 5_000; // how often we ask our server for buses
const SLIDE_MS = 1_500; // how long a bus takes to glide to its new position
const ROUTES_REFRESH_MS = 5 * 60_000; // re-check which routes are running (e.g. the 6 PM switch)
const ARRIVALS_REFRESH_MS = 10_000; // refresh an open stop popup this often
const STOPS_MIN_ZOOM = 14; // hide stops when zoomed far out (too cluttered)

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
// A "Map ID" is required for modern markers. Ours hides Google's restaurant/shop icons.
// DEMO_MAP_ID is Google's free test ID, used until ours is set in .env.
const MAP_ID = import.meta.env.VITE_GOOGLE_MAP_ID || 'DEMO_MAP_ID';

// Demo mode: open the app with ?demo to replay recorded bus data instead of live data.
const DEMO = new URLSearchParams(location.search).has('demo');
const api = (path) => (DEMO ? `${path}?demo=1` : path);

// Label the app "Demo" only when the server confirms it's replaying a recording.
function showDemoBadge() {
  if (document.querySelector('.demo-badge')) return;
  const badge = document.createElement('span');
  badge.className = 'demo-badge';
  badge.textContent = 'Demo';
  document.getElementById('search').append(badge);
}

const statusEl = document.getElementById('status');
const filterEl = document.getElementById('route-filter');

let map;
let AdvancedMarkerElement;
let decodePath;
let infoWindow;

let routes = []; // every route from TransLoc
let routesById = new Map(); // routeId -> route
let runningSignature = ''; // which routes are running, so we only redraw when it changes
let selectedRouteId = loadSavedRoute(); // null = show all routes

const routeLines = new Map(); // routeId -> [outline Polyline, colored Polyline]
const stopMarkers = new Map(); // stopId -> { marker, stop }
const buses = new Map(); // vehicleId -> { marker, el, arrow, routeId, from, to, slideStart }
let highlightedBusId = null; // the bus a shared-ETA link is following (bigger marker)
let bunches = []; // buses running right behind each other (from our server, see server/bunching.js)
let lastUpdate = { ok: false, at: 0, count: 0, message: 'Loading buses…' };

// ---------- Start-up ----------

start();
showInstallTipIfNeeded();
initThemeToggle();
initCavToggle();

// The service worker (offline page) only runs in the built app, not while developing,
// so code changes always show up immediately during development.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch((err) => console.error('Service worker:', err));
}

async function start() {
  if (!MAPS_KEY) {
    showStatus('Missing Google Maps key (VITE_GOOGLE_MAPS_KEY in .env)', true);
    return;
  }
  // Ask our server for routes + buses now, while Google's map downloads (they don't need the map).
  const firstRoutes = fetchJson(api('/api/routes'));
  const firstBuses = fetchJson(api('/api/vehicles'), { headers: { 'X-Device': deviceId() } });

  try {
    await loadGoogleMaps(MAPS_KEY);
  } catch (err) {
    showStatus('Google Maps could not load. Check your connection.', true);
    console.error(err);
    return;
  }

  const { Map: GoogleMap, InfoWindow } = await google.maps.importLibrary('maps');
  ({ AdvancedMarkerElement } = await google.maps.importLibrary('marker'));
  ({ decodePath } = (await google.maps.importLibrary('geometry')).encoding);

  map = new GoogleMap(document.getElementById('map'), {
    center: GROUNDS_CENTER,
    zoom: 15,
    mapId: MAP_ID,
    // Dark mode uses the dark style linked to our Map ID in Google Cloud ("hoomap").
    colorScheme: currentTheme() === 'dark' ? 'DARK' : 'LIGHT',
    gestureHandling: 'greedy', // one finger pans on phones
    clickableIcons: false,
    disableDefaultUI: true,
    // +/- buttons on laptops only; phones pinch to zoom.
    zoomControl: !window.matchMedia('(pointer: coarse)').matches,
  });
  infoWindow = new InfoWindow();
  // Closing a popup while a trip is open: slide the map back to the whole trip
  // (Google slides the map to fit a tall popup, which can push the trip off-screen).
  infoWindow.addListener('closeclick', () => {
    stopArrivalsRefresh();
    afterPopupClosed();
  });
  // Google slides the map so a popup fits the map, but it doesn't know our search bar and
  // route buttons sit on top. Once it's done, nudge the map down if the popup's top is hidden.
  infoWindow.addListener('domready', () => {
    google.maps.event.addListenerOnce(map, 'idle', keepPopupBelowTopBar);
    setTimeout(keepPopupBelowTopBar, 450); // in case the map didn't need to move at all
  });
  // Tap anywhere on the map to close a stop popup (easier than the small ✕ on phones).
  map.addListener('click', () => {
    const wasOpen = popupOpen;
    infoWindow.close();
    stopArrivalsRefresh();
    if (wasOpen) afterPopupClosed();
  });
  initReports({ demo: DEMO, afterSend: () => pollBuses() });
  initLocate({ map, AdvancedMarkerElement });
  map.addListener('zoom_changed', applyFilter);

  initSearch({
    map,
    AdvancedMarkerElement,
    decodePath,
    demo: DEMO,
    showPopup,
    focusRoute,
    unfocusRoute,
    focusNone,
    nearestStop,
    openStopById,
  });
  initFavorites({
    demo: DEMO,
    openStopById,
    openPlace,
    openTripTo,
    optionName,
    panTo(position) {
      map.panTo(position);
      if (map.getZoom() < 16) map.setZoom(16);
    },
  });

  await loadRoutes(firstRoutes);
  setInterval(loadRoutes, ROUTES_REFRESH_MS);
  // Share my ETA: the button in bus popups, and the friend's view for ?eta= links.
  initEta({
    map,
    AdvancedMarkerElement,
    demo: DEMO,
    routeStops,
    routeName: (routeId) => routesById.get(routeId)?.name || 'bus',
    tripPlanFor,
    focusRoute,
    unfocusRoute,
    highlightBus(vehicleId) {
      highlightedBusId = vehicleId;
      for (const [id, bus] of buses) {
        bus.el.classList.toggle('shared-bus', id === vehicleId);
        bus.marker.zIndex = id === vehicleId ? 15 : 10;
      }
    },
    setHomePanelVisible,
  });
  // Opened by tapping a leave-now reminder (/?remind=<class id>), or tapped one while open.
  openFromReminder(new URLSearchParams(location.search).get('remind'));
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type === 'open-url') openFromReminder(new URL(event.data.url, location.origin).searchParams.get('remind'));
  });
  pollBuses(firstBuses);
  setInterval(renderStatus, 1_000); // keeps "updated Xs ago" fresh
}

// Adds Google's map script to the page and waits for it to finish loading.
function loadGoogleMaps(key) {
  return new Promise((resolve, reject) => {
    window.__onGoogleMapsLoaded = resolve;
    const script = document.createElement('script');
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}` +
      '&v=weekly&loading=async&callback=__onGoogleMapsLoaded';
    script.async = true;
    script.onerror = () => reject(new Error('Google Maps script failed to load'));
    document.head.append(script);
  });
}

// ---------- Routes + stops ----------

const ROUTES_RETRY_MS = 5_000;
let routesRetryTimer = null;

// fetch + JSON in one step. Resolves to null (never throws) if anything fails.
function fetchJson(url, options) {
  return fetch(url, options)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
}

// prefetched: an answer already on its way (started at startup), used once.
async function loadRoutes(prefetched) {
  clearTimeout(routesRetryTimer);
  const data = await (prefetched || fetchJson(api('/api/routes')));
  if (!data) console.error('Could not load routes. Retrying in 5s.');
  // No route list yet (server waking up, weak signal): try again soon, not in 5 minutes.
  if (!data?.routes?.length) {
    if (!routes.length) routesRetryTimer = setTimeout(loadRoutes, ROUTES_RETRY_MS);
    return;
  }

  routes = data.routes;
  routesById = new Map(routes.map((r) => [r.id, r]));

  const running = routes.filter((r) => r.isRunning);
  const signature = running.map((r) => r.id).join(',');
  if (signature === runningSignature) return; // nothing changed since last check
  runningSignature = signature;

  if (selectedRouteId && !running.some((r) => r.id === selectedRouteId)) selectedRouteId = null;

  drawRouteLines(running);
  drawStops(data.stops, new Set(running.map((r) => r.id)));
  drawFilterButtons(running);
  applyFilter();
}

function drawRouteLines(running) {
  for (const lines of routeLines.values()) for (const l of lines) l.setMap(null);
  routeLines.clear();
  const dark = currentTheme() === 'dark';
  for (const r of running) {
    if (!r.line) continue;
    const path = decodePath(r.line);
    // A thin light outline under each line, so routes stand out on green parks (Green Line)
    // and on the dark map (Night Pilot is navy).
    const outline = new google.maps.Polyline({
      path,
      strokeColor: '#ffffff',
      strokeOpacity: dark ? 0.55 : 0.9,
      strokeWeight: 7,
      clickable: false,
      zIndex: 1,
      map,
    });
    const line = new google.maps.Polyline({
      path,
      strokeColor: r.color,
      strokeOpacity: 0.9,
      strokeWeight: 4,
      clickable: false,
      zIndex: 2,
      map,
    });
    routeLines.set(r.id, [outline, line]);
  }
}

function drawStops(stops, runningIds) {
  for (const { marker } of stopMarkers.values()) marker.map = null;
  stopMarkers.clear();

  for (const stop of stops) {
    // Only keep the routes that are running now; skip stops no running route visits.
    const activeRouteIds = stop.routeIds.filter((id) => runningIds.has(id));
    if (!activeRouteIds.length) continue;

    const el = document.createElement('div');
    el.className = 'stop';
    const marker = new AdvancedMarkerElement({
      position: { lat: stop.lat, lng: stop.lng },
      content: el,
      title: stop.name,
      gmpClickable: true,
      zIndex: 1,
    });
    marker.addEventListener('gmp-click', () => openStop(stop, marker));
    stopMarkers.set(stop.id, { marker, stop: { ...stop, routeIds: activeRouteIds } });
  }
}

// ---------- Route filter (buttons at the top) ----------

function drawFilterButtons(running) {
  filterEl.replaceChildren();
  // Two routes can share a name (e.g. two "Purple Line"s). Add their note to tell them apart.
  const nameCounts = {};
  for (const r of running) nameCounts[r.name] = (nameCounts[r.name] || 0) + 1;

  filterEl.append(makeFilterButton(null, 'All routes', null));
  for (const r of running) {
    const label = nameCounts[r.name] > 1 && r.note ? shortLabel(r) : r.name;
    filterEl.append(makeFilterButton(r.id, label, r.color));
  }
}

// Two routes with the same name: "Purple · Fontaine" instead of "Purple Line · Fontaine Service".
function shortLabel(r) {
  const note = r.note.replace(/\s*Service$/i, '').replace(/Scott Stadium/i, 'Stadium');
  return `${r.name.replace(/\s+(Line|Loop)\s*$/i, '')} · ${note}`;
}

function makeFilterButton(routeId, label, color) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip';
  btn.dataset.routeId = routeId ?? '';
  if (color) {
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = color;
    btn.append(swatch);
  }
  btn.append(label);
  btn.addEventListener('click', () => selectRoute(routeId));
  return btn;
}

function selectRoute(routeId) {
  focusSaved = undefined; // the user chose a filter themselves: keep it after the trip closes
  selectedRouteId = routeId;
  saveRoute(routeId);
  applyFilter();
  infoWindow.close();
  stopArrivalsRefresh();

  // Zoom the map to fit the chosen route.
  const line = routeLines.get(routeId)?.[1];
  if (line) {
    const bounds = new google.maps.LatLngBounds();
    line.getPath().forEach((point) => bounds.extend(point));
    map.fitBounds(bounds, { top: 130, bottom: 70, left: 16, right: 16 });
  }
}

// Trip card: show just one route while you look at a trip, without changing your saved filter.
let focusSaved; // the filter to go back to (undefined = not focusing)

function focusRoute(routeId) {
  if (!routesById.has(routeId)) return;
  if (focusSaved === undefined) focusSaved = selectedRouteId;
  selectedRouteId = routeId;
  applyFilter();
}

// CAT-only or walking trip: hide every UVA route (lines, stops, buses) so only your path shows.
const NO_ROUTE = -1;
function focusNone() {
  if (focusSaved === undefined) focusSaved = selectedRouteId;
  selectedRouteId = NO_ROUTE;
  applyFilter();
}

function unfocusRoute() {
  if (focusSaved === undefined) return;
  selectedRouteId = focusSaved;
  focusSaved = undefined;
  applyFilter();
}

const showsRoute = (routeId) => selectedRouteId === null || selectedRouteId === routeId;

// Shows/hides lines, stops, and buses to match the chosen route.
function applyFilter() {
  for (const [routeId, lines] of routeLines) for (const l of lines) l.setMap(showsRoute(routeId) ? map : null);

  const zoomedInEnough = map.getZoom() >= STOPS_MIN_ZOOM;
  for (const { marker, stop } of stopMarkers.values()) {
    const visible = zoomedInEnough && stop.routeIds.some(showsRoute);
    const target = visible ? map : null;
    if (marker.map !== target) marker.map = target;
  }

  for (const bus of buses.values()) {
    const target = showsRoute(bus.routeId) ? map : null;
    if (bus.marker.map !== target) bus.marker.map = target;
  }

  for (const btn of filterEl.children) {
    const id = btn.dataset.routeId === '' ? null : Number(btn.dataset.routeId);
    btn.setAttribute('aria-pressed', String(id === selectedRouteId));
  }
}

function loadSavedRoute() {
  try {
    const saved = localStorage.getItem('hoos-riding.route');
    return saved ? Number(saved) : null;
  } catch {
    return null;
  }
}

function saveRoute(routeId) {
  try {
    if (routeId === null) localStorage.removeItem('hoos-riding.route');
    else localStorage.setItem('hoos-riding.route', String(routeId));
  } catch {
    // Private browsing can block storage; the filter still works for this visit.
  }
}

// ---------- Stop popup with arrival times ----------

let arrivalsTimer = null;
let popupOpen = false; // is a stop / bus popup showing?

function openStop(stop, marker) {
  stopArrivalsRefresh();
  const box = document.createElement('div');
  box.className = 'stop-popup';
  const title = document.createElement('h2');
  title.textContent = stop.name;
  const list = document.createElement('div');
  list.className = 'arrivals';
  list.textContent = 'Loading arrival times…';
  const star = starButton({ isSaved: () => isStopSaved(stop.id), toggle: () => toggleStop(stop), saveLabel: 'Save stop' });
  const reported = document.createElement('div'); // "A rider says skipped stop · 4 min ago"
  const actions = document.createElement('div');
  actions.className = 'popup-actions';
  const directions = directionsButton(stop);
  directions.addEventListener('click', () => infoWindow.close());
  actions.append(star, directions);
  box.append(title, list, reported, actions, reportButtons(STOP_KINDS, { stopId: stop.id }, 'Report this stop'));

  infoWindow.setContent(box);
  openPopupAt(marker);
  popupOpen = true;

  const refresh = async () => {
    reported.replaceChildren(reportList(stopReports(stop.id)) || '');
    await renderArrivals(stop, list);
    arrivalsTimer = setTimeout(refresh, ARRIVALS_REFRESH_MS);
  };
  refresh();
}

// Open the popup on a marker. On phones the trip card shrinks first, so the popup has room.
function openPopupAt(anchor) {
  shrinkForPopup();
  infoWindow.open({ map, anchor });
}

// If the open popup's top is under the search bar / route buttons, slide the map down a bit.
function keepPopupBelowTopBar() {
  if (!popupOpen) return;
  const popup = document.querySelector('.gm-style .gm-style-iw-c');
  if (!popup) return;
  const bars = [document.getElementById('search'), document.getElementById('route-filter')]
    .filter((el) => el && !el.hidden && el.offsetHeight);
  const barBottom = Math.max(0, ...bars.map((el) => el.getBoundingClientRect().bottom));
  const hidden = barBottom + 8 - popup.getBoundingClientRect().top;
  if (hidden > 1) map.panBy(0, -Math.round(hidden));
}

// Used by the search card: show any content in the map's popup (e.g. a CAT stop).
function showPopup(content, anchor) {
  stopArrivalsRefresh();
  infoWindow.setContent(content);
  openPopupAt(anchor);
  popupOpen = true;
}

// Used by the trip card: the closest stop (served by a running route) to a place, or null.
function nearestStop(point) {
  let best = null;
  for (const { stop } of stopMarkers.values()) {
    const m = Math.hypot((stop.lat - point.lat) * 111_320, (stop.lng - point.lng) * 111_320 * Math.cos((point.lat * Math.PI) / 180));
    if (!best || m < best.meters) best = { id: stop.id, name: stop.name, meters: m };
  }
  return best;
}

// Leave-now reminder tapped: that class's trip, with the best option shown. Then tidy the address.
function openFromReminder(classId) {
  if (!classId) return;
  openReminderTrip(classId);
  const url = new URL(location.href);
  url.searchParams.delete('remind');
  history.replaceState(null, '', url);
}

// Share my ETA: a route's stops in the order the bus visits them (each stop once).
function routeStops(routeId) {
  const seen = new Set();
  const list = [];
  for (const id of routesById.get(routeId)?.stopIds || []) {
    const entry = stopMarkers.get(id);
    if (!entry || seen.has(id)) continue;
    seen.add(id);
    list.push({ id, name: entry.stop.name });
  }
  return list;
}

// Used by the search card: open a stop's arrival popup by its ID.
// Returns false if that stop isn't on the map right now (e.g. its route isn't running).
function openStopById(stopId) {
  const entry = stopMarkers.get(stopId);
  if (!entry) return false;
  // The route filter hides this stop (e.g. searched a Gold stop while showing Purple): show all routes.
  if (!entry.stop.routeIds.some(showsRoute)) selectRoute(null);
  if (map.getZoom() < STOPS_MIN_ZOOM) map.setZoom(STOPS_MIN_ZOOM);
  applyFilter(); // make sure the stop's marker is on the map before attaching the popup
  // Off-screen or near the edge: center on it first (Google alone only slides the map just
  // enough to fit the popup, which can leave the stop wedged in a corner).
  if (!nearMiddle(entry.stop)) map.setCenter({ lat: entry.stop.lat, lng: entry.stop.lng });
  openStop(entry.stop, entry.marker);
  return true;
}

// Is this point inside the middle ~60% of the map view?
function nearMiddle(p) {
  const b = map.getBounds();
  if (!b) return false;
  const ne = b.getNorthEast();
  const sw = b.getSouthWest();
  const padLat = (ne.lat() - sw.lat()) * 0.2;
  const padLng = (ne.lng() - sw.lng()) * 0.2;
  return p.lat > sw.lat() + padLat && p.lat < ne.lat() - padLat && p.lng > sw.lng() + padLng && p.lng < ne.lng() - padLng;
}

function stopArrivalsRefresh() {
  clearTimeout(arrivalsTimer);
  arrivalsTimer = null;
  openBus = null; // whatever popup was open is gone or being replaced
  popupOpen = false;
}

async function renderArrivals(stop, list) {
  let data;
  try {
    const res = await fetch(api(`/api/stops/${stop.id}/arrivals`));
    data = await res.json();
    if (data.error) throw new Error(data.error);
  } catch (err) {
    console.error(err);
    list.textContent = 'Arrival times are unavailable right now.';
    return;
  }

  // Our server may have fetched these a few seconds ago; count that time down too.
  const ageSecs = (Date.now() - data.fetchedAt) / 1000;
  const rows = data.arrivals
    .filter((a) => showsRoute(a.routeId))
    .filter((a) => a.times.length || routesById.get(a.routeId)?.isRunning);

  list.replaceChildren();
  if (!rows.length) {
    list.textContent = 'No buses expected here right now.';
    return;
  }

  for (const a of rows) {
    const row = document.createElement('div');
    row.className = 'arrival';

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = a.color;

    const name = document.createElement('span');
    name.className = 'arrival-route';
    name.textContent = a.routeName;

    const times = document.createElement('span');
    times.className = 'arrival-times';
    const shown = a.times.slice(0, 3);
    // ⏸ after a time whose bus is parked (its countdown may be frozen).
    times.textContent = shown.length
      ? shown.map((t) => formatWait(t.seconds - ageSecs, t.arriving) + (parkedInfo(t.vehicleId) ? ' ⏸' : '')).join(' · ')
      : 'No upcoming buses';

    row.append(swatch, name, times);
    for (const text of [parkedNote(shown, stop, ageSecs), bunchNote(a, ageSecs)]) {
      if (!text) continue;
      const note = document.createElement('div');
      note.className = 'live-note';
      note.textContent = text;
      row.append(note);
    }
    list.append(row);
  }
}

// "⏸ The bus in 1 min has been parked…" for the first listed bus that's parked somewhere.
function parkedNote(times, stop, ageSecs) {
  for (const t of times) {
    const p = parkedInfo(t.vehicleId);
    if (!p) continue;
    if (p.stopId === stop.id) {
      return `⏸ This bus has been parked here for ${parkedDetail({ ...p, stopName: null })}. It may leave later than shown.`;
    }
    const when = formatWait(t.seconds - ageSecs, t.arriving);
    return `⏸ The bus shown as "${when}" has been parked ${parkedDetail(p)}, so it may take longer.`;
  }
  return null;
}

// "⚠️ 2 buses are bunched up…" when buses of a bunch are this stop's next arrivals in a row.
const BUNCH_TOGETHER_S = 5 * 60; // bunched buses reach the stop within 5 min of each other
const LONG_WAIT_S = 6 * 60; // only call the wait after them "long" from 6 min
function bunchNote(a, ageSecs) {
  const times = a.times.map((t) => ({ id: t.vehicleId, s: t.seconds - ageSecs }));
  for (const bunch of bunches) {
    if (bunch.routeId !== a.routeId) continue;
    const start = times.findIndex((t) => bunch.vehicleIds.includes(t.id));
    if (start < 0 || start > 2) continue;
    // Count the bunch's buses arriving one after another (different buses, close in time).
    const ids = [times[start].id];
    let end = start;
    while (
      times[end + 1] && bunch.vehicleIds.includes(times[end + 1].id) && !ids.includes(times[end + 1].id) &&
      times[end + 1].s - times[end].s <= BUNCH_TOGETHER_S
    ) {
      end++;
      ids.push(times[end].id);
    }
    if (ids.length < 2) continue;

    // Wait after them: from TransLoc's next time if it shows one, else our estimate.
    const next = times[end + 1];
    const wait = next ? next.s - times[end].s : bunch.gapAfterS;
    const lead = `⚠️ ${ids.length} buses are bunched up: they'll come together`;
    if (wait == null || wait < LONG_WAIT_S) return `${lead}.`;
    return `${lead}, then the next one is ${next ? '' : 'about '}${Math.round(wait / 60)} min later.`;
  }
  return null;
}

function formatWait(seconds, arriving) {
  if (arriving || seconds < 60) return 'Now';
  return `${Math.round(seconds / 60)} min`;
}

// ---------- Buses ----------

let pollTimer = null;

async function pollBuses(prefetched) {
  clearTimeout(pollTimer);
  try {
    // The very first time, use the answer we started fetching at startup (if it worked).
    let data = prefetched ? await prefetched : null;
    if (!data) {
      const res = await fetch(api('/api/vehicles'), { headers: { 'X-Device': deviceId() } });
      if (!res.ok) throw new Error(`Server answered ${res.status}`);
      data = await res.json();
    }
    if (data.demo) showDemoBadge();
    setReports(data.reports);
    bunches = data.bunches || [];
    setParked(data.parked);
    updateBuses(data.vehicles);
    const stale = Date.now() - data.fetchedAt > POLL_MS * 4;
    lastUpdate = data.error && stale
      ? { ok: false, message: 'UVA bus data is unavailable right now. Retrying…' }
      : { ok: true, at: data.fetchedAt, count: data.vehicles.length };
  } catch (err) {
    console.error(err);
    lastUpdate = { ok: false, message: "Can't reach HooMaps. Retrying…" };
  }
  renderStatus();
  // Don't poll while the app is in the background (saves battery and data).
  if (!document.hidden) pollTimer = setTimeout(pollBuses, POLL_MS);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && map) pollBuses(); // back in the app: refresh right away
});

function updateBuses(vehicles) {
  const seen = new Set();
  const now = performance.now();

  for (const v of vehicles) {
    seen.add(v.id);
    const route = routesById.get(v.routeId) || { name: 'Unknown route', color: '#777777' };
    const target = { lat: v.lat, lng: v.lng };
    let bus = buses.get(v.id);

    if (!bus) {
      bus = createBusMarker(target, v.id);
      buses.set(v.id, bus);
    } else {
      // Glide from wherever the marker is now to the new position.
      bus.from = currentPosition(bus, now);
      bus.to = target;
      bus.slideStart = now;
    }

    bus.routeId = v.routeId;
    bus.data = v;
    const warnings = busWarnings(v.id);
    bus.el.classList.toggle('reported', warnings.length > 0); // small ! badge on the bus
    bus.el.style.setProperty('--route-color', route.color);
    bus.el.style.setProperty('--arrow-color', readableOn(route.color));
    bus.el.classList.toggle('stopped', v.speed === 0);
    bus.el.classList.toggle('delayed', Boolean(v.delayed));
    bus.el.classList.toggle('shared-bus', v.id === highlightedBusId);
    if (v.id === highlightedBusId) bus.marker.zIndex = 15;
    bus.el.dataset.facing = v.heading > 180 ? 'left' : 'right'; // for Cav mode's side-view faces
    bus.arrow.style.transform = `rotate(${v.heading}deg)`;
    bus.marker.title = `${route.name}, bus ${v.name}${v.delayed ? ' (delayed)' : ''}` +
      (warnings.length ? `. Riders report: ${warnings.map((w) => w.kind.replace('_', ' ')).join(', ')}` : '') +
      '. Tap for details.';
  }

  // Keep an open bus popup up to date (rider count, reports); close it if the bus left.
  if (openBus) {
    if (buses.has(openBus.id)) openBus.refresh();
    else infoWindow.close();
  }

  // Remove buses that are no longer reporting (e.g. went out of service).
  for (const [id, bus] of buses) {
    if (!seen.has(id)) {
      bus.marker.map = null;
      buses.delete(id);
    }
  }

  applyFilter();
  if (!sliding) {
    sliding = true;
    lastFrameAt = 0;
    requestAnimationFrame(slideFrame);
  }
}

function createBusMarker(position, vehicleId) {
  const el = document.createElement('div');
  el.className = 'bus';
  const arrow = document.createElement('div');
  arrow.className = 'bus-arrow';
  el.append(arrow);

  // zIndex keeps buses drawn on top of stops. Tap a bus for its popup.
  const marker = new AdvancedMarkerElement({ position, content: el, zIndex: 10, gmpClickable: true });
  marker.addEventListener('gmp-click', () => openBusPopup(vehicleId));
  return { marker, el, arrow, routeId: null, from: position, to: position, slideStart: 0 };
}

// ---------- Bus popup: how full it is, rider reports, report buttons ----------

let openBus = null; // { id, refresh }

function openBusPopup(vehicleId) {
  const bus = buses.get(vehicleId);
  if (!bus) return;
  stopArrivalsRefresh();

  const box = document.createElement('div');
  box.className = 'stop-popup';
  const title = document.createElement('h2');
  const full = document.createElement('div');
  full.className = 'bus-full';
  const parkedLine = document.createElement('div');
  parkedLine.className = 'live-note';
  const reported = document.createElement('div');
  box.append(title, full, parkedLine, reported, shareSection(vehicleId, bus.routeId), reportButtons(BUS_KINDS, { vehicleId }, 'Report this bus'));

  const refresh = () => {
    const v = buses.get(vehicleId)?.data;
    if (!v) return;
    const route = routesById.get(v.routeId);
    title.textContent = `${route?.name || 'Bus'} · bus ${v.name}`;
    full.replaceChildren(fullness(v));
    const p = parkedInfo(vehicleId);
    parkedLine.textContent = p ? `⏸ Parked ${parkedDetail(p)}.` : '';
    parkedLine.hidden = !p;
    reported.replaceChildren(reportList(busReports(vehicleId)) || '');
  };
  refresh();
  infoWindow.setContent(box);
  openPopupAt(bus.marker);
  popupOpen = true;
  openBus = { id: vehicleId, refresh };
}

// "18 of 50 riders" with a little bar (TransLoc's live passenger counter).
function fullness(v) {
  const el = document.createElement('div');
  if (!(v.capacity > 0) || v.riders === undefined) {
    el.textContent = '👥 Rider count not available';
    return el;
  }
  if (v.riders === 0) {
    el.textContent = '👥 No riders counted (the counter may be off)';
    return el;
  }
  const share = Math.min(1, v.riders / v.capacity);
  el.textContent = `👥 ${v.riders} of ${v.capacity} riders${share >= 0.8 ? ' · very full' : share >= 0.6 ? ' · busy' : ''}`;
  const bar = document.createElement('div');
  bar.className = 'full-bar';
  bar.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('div');
  fill.style.width = `${Math.round(share * 100)}%`;
  fill.className = share >= 0.8 ? 'high' : share >= 0.6 ? 'mid' : '';
  bar.append(fill);
  el.append(bar);
  return el;
}

function currentPosition(bus, now) {
  const t = Math.min(1, (now - bus.slideStart) / SLIDE_MS);
  return {
    lat: bus.from.lat + (bus.to.lat - bus.from.lat) * t,
    lng: bus.from.lng + (bus.to.lng - bus.from.lng) * t,
  };
}

// Moves every bus a little each animation frame until all have arrived.
// Phones: moving 15 markers 60 times a second is heavy, so we move them ~20 times a second
// (still looks smooth), and buses that are off-screen or hidden by the filter just jump.
const FRAME_MS = 50;
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let lastFrameAt = 0;
let sliding = false;

function slideFrame(now) {
  if (now - lastFrameAt < FRAME_MS) {
    requestAnimationFrame(slideFrame);
    return;
  }
  lastFrameAt = now;
  const bounds = map.getBounds();
  let stillMoving = false;
  for (const bus of buses.values()) {
    const onScreen = bus.marker.map && (!bounds || bounds.contains(bus.to) || bounds.contains(bus.from));
    if (!REDUCED_MOTION && onScreen && now - bus.slideStart < SLIDE_MS) {
      bus.marker.position = currentPosition(bus, now);
      stillMoving = true;
    } else if (bus.marker.position?.lat !== bus.to.lat || bus.marker.position?.lng !== bus.to.lng) {
      bus.marker.position = bus.to;
    }
  }
  sliding = stillMoving;
  if (stillMoving) requestAnimationFrame(slideFrame);
}

// Navy arrow on light colors (like Gold), white arrow on dark colors (like Purple).
function readableOn(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#232d4b' : '#ffffff';
}

// ---------- Status pill ----------

function renderStatus() {
  if (!lastUpdate.ok) return showStatus(lastUpdate.message, true);
  const shown = [...buses.values()].filter((b) => showsRoute(b.routeId)).length;
  if (shown === 0) {
    return showStatus(selectedRouteId ? 'No buses on this route right now' : 'No UVA buses running right now');
  }
  const secs = Math.max(0, Math.round((Date.now() - lastUpdate.at) / 1000));
  showStatus(`${shown} bus${shown === 1 ? '' : 'es'} live · updated ${secs}s ago`);
}

function showStatus(text, warning = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('warning', warning);
}
