// "Where am I?": the 📍 button shows a live blue dot that follows you on the map.
// - Your location stays on this phone. It is never sent to our server.
// - Tracking runs only while HooMaps is open on screen (stops in the background: saves battery).
// - Tap 📍: start + center on you. Tap again: re-center (or turn off if you're already centered).
// - Remembers that you turned it on; next time it restarts by itself if the phone already allows it.
// - Trip search (search.js) uses this live position instead of asking the phone again.

const KEY = 'hoos-riding.locate';
const FRESH_MS = 30_000; // a position this recent counts as "live"
const CENTERED_M = 40; // map center this close to you = "already centered"

let map;
let AdvancedMarkerElement;
let btn;
let dot = null; // the blue dot marker
let ring = null; // light circle showing how accurate the position is
let watchId = null;
let wanted = false; // the user turned it on
let centerNext = false; // center the map on the next position
let last = null; // { lat, lng, accuracy, at }

export function initLocate(options) {
  ({ map, AdvancedMarkerElement } = options);
  btn = document.getElementById('locate-btn');
  if (!navigator.geolocation) return; // no button if the browser can't do it
  btn.hidden = false;
  btn.addEventListener('click', onTap);
  update();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopWatching();
    else if (wanted) startWatching();
  });

  // Turned on last time? Restart quietly, but only if the phone already allows it (no surprise pop-up).
  let rememberedOn = false;
  try {
    rememberedOn = localStorage.getItem(KEY) === '1';
  } catch {
    // storage blocked
  }
  if (rememberedOn && navigator.permissions?.query) {
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((p) => {
        if (p.state === 'granted') turnOn({ center: true });
      })
      .catch(() => {});
  }
}

// The latest live position, or null (used by trip search).
export function liveLocation() {
  return wanted && last && Date.now() - last.at < FRESH_MS ? { lat: last.lat, lng: last.lng } : null;
}

function onTap() {
  if (!wanted) return turnOn({ center: true });
  if (!last) return; // still finding you
  const center = map.getCenter();
  const far = !center || metersBetween({ lat: center.lat(), lng: center.lng() }, last) > CENTERED_M;
  if (far) centerOn(last);
  else turnOff();
}

function turnOn({ center }) {
  wanted = true;
  centerNext = center;
  remember(true);
  document.body.classList.add('locating');
  startWatching();
  update();
}

function turnOff() {
  wanted = false;
  remember(false);
  stopWatching();
  document.body.classList.remove('locating');
  if (dot) dot.map = null;
  if (ring) ring.setMap(null);
  last = null;
  update();
}

function startWatching() {
  if (watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(onPosition, onError, {
    enableHighAccuracy: true,
    maximumAge: 5_000,
    timeout: 20_000,
  });
}

function stopWatching() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function onPosition(pos) {
  last = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, at: Date.now() };
  const position = { lat: last.lat, lng: last.lng };

  if (!dot) {
    const el = document.createElement('div');
    el.className = 'you-dot live';
    dot = new AdvancedMarkerElement({ position, content: el, title: 'You are here', zIndex: 30 });
    ring = new google.maps.Circle({
      center: position,
      radius: last.accuracy,
      strokeOpacity: 0,
      fillColor: '#1a73e8',
      fillOpacity: 0.12,
      clickable: false,
      zIndex: 0,
    });
  }
  dot.position = position;
  dot.map = map;
  ring.setCenter(position);
  ring.setRadius(Math.min(last.accuracy, 500));
  ring.setMap(map);

  if (centerNext) {
    centerNext = false;
    centerOn(last);
  }
  update();
}

function onError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    turnOff();
    toast('Location is off for HooMaps. Turn it on in your phone’s settings (Safari → Location) to see your dot.');
  } else if (!last) {
    toast('Can’t find your location right now. Still trying…');
  }
}

function centerOn(p) {
  map.panTo({ lat: p.lat, lng: p.lng });
  if (map.getZoom() < 16) map.setZoom(16);
}

// Button look: off / finding you / on.
function update() {
  const state = !wanted ? 'off' : last ? 'on' : 'finding';
  btn.dataset.state = state;
  btn.setAttribute('aria-pressed', String(wanted));
  btn.setAttribute(
    'aria-label',
    state === 'off' ? 'Show my location' : state === 'finding' ? 'Finding your location' : 'Center on my location (tap again to turn off)',
  );
}

function remember(on) {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // storage blocked: works for this visit
  }
}

let toastEl = null;
let toastTimer = null;
function toast(text) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    document.body.append(toastEl);
  }
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 5_000);
}

function metersBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}
