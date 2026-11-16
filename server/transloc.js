// Talking to TransLoc: fetch raw data and reshape it into the simple format our app uses.
// Shared by the server (server/index.js) and the demo recorder (scripts/record-demo.js).

const TRANSLOC_BASE = 'https://uva.transloc.com/Services/JSONPRelay.svc';

function apiKey() {
  const key = process.env.TRANSLOC_API_KEY;
  if (!key) throw new Error('Missing TRANSLOC_API_KEY. Add it to .env (see .env.example).');
  return key;
}

async function fetchTransLoc(endpoint) {
  const res = await fetch(`${TRANSLOC_BASE}/${endpoint}`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`TransLoc answered ${res.status} for ${endpoint.split('?')[0]}`);
  return res.json();
}

// TransLoc dates look like "/Date(1794459910000-0700)/". Pull out the milliseconds.
function parseTransLocDate(value) {
  const match = /\/Date\((\d+)/.exec(value || '');
  return match ? Number(match[1]) : null;
}

// Where every bus is right now.
export async function fetchVehicles() {
  const raw = await fetchTransLoc(`GetMapVehiclePoints?apiKey=${apiKey()}&isPublicMap=true`);
  return raw.map((v) => ({
    id: v.VehicleID,
    name: v.Name,
    routeId: v.RouteID,
    lat: v.Latitude,
    lng: v.Longitude,
    heading: v.Heading,
    speed: v.GroundSpeed,
    delayed: v.IsDelayed,
    onRoute: v.IsOnRoute,
    reportedAt: parseTransLocDate(v.TimeStamp),
  }));
}

// How many riders are on each bus right now (TransLoc's passenger counters). No key needed.
// Returns Map(vehicleId -> { riders, capacity }).
export async function fetchCapacities() {
  const raw = await fetchTransLoc('GetVehicleCapacities');
  return new Map(raw.map((c) => [c.VehicleID, { riders: c.CurrentOccupation, capacity: c.Capacity }]));
}

// Every route (with its line shape) plus every stop, merged so each stop appears once.
export async function fetchRoutesAndStops() {
  const raw = await fetchTransLoc(
    `GetRoutesForMapWithScheduleWithEncodedLine?apiKey=${apiKey()}&isDispatch=false`,
  );

  const routes = raw.map((r) => ({
    id: r.RouteID,
    name: r.Description.trim(),
    note: (r.InfoText || '').trim(), // e.g. "Pre-6PM", "Fontaine Service"
    color: r.MapLineColor,
    isRunning: r.IsRunning,
    line: r.EncodedPolyline, // the route's shape, in Google's compact "encoded polyline" format
    stopIds: r.Stops.map((s) => s.AddressID),
  }));

  // The same stop (e.g. O-Hill) appears on several routes. Merge them into one stop each.
  const stopsById = new Map();
  for (const r of raw) {
    for (const s of r.Stops) {
      const stop = stopsById.get(s.AddressID) || {
        id: s.AddressID,
        name: s.Description.trim(),
        lat: s.Latitude,
        lng: s.Longitude,
        routeIds: [],
      };
      stop.routeIds.push(r.RouteID);
      stopsById.set(s.AddressID, stop);
    }
  }

  return { routes, stops: [...stopsById.values()] };
}

// Upcoming buses at one stop. (TransLoc only answers correctly for one stop per request.)
export async function fetchArrivals(stopId) {
  const raw = await fetchTransLoc(
    `GetStopArrivalTimes?apiKey=${apiKey()}&stopIds=${stopId}&version=2`,
  );
  return raw.map((a) => ({
    routeId: a.RouteId,
    routeName: a.RouteDescription.trim(),
    color: a.Color,
    times: (a.Times || []).map((t) => ({
      seconds: t.Seconds,
      vehicleId: t.VehicleId,
      arriving: t.IsArriving,
    })),
  }));
}
