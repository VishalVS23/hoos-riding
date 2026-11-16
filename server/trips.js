// Trip options: "how do I get from A to B, and is walking faster?"
// Compares, sorted by arrival time:
//   - UVA buses (live, TransLoc): walk to the stop → wait → ride → walk to the place
//   - CAT buses (scheduled, Google)
//   - UVA ↔ CAT transfers (long trips only), e.g. Purple Line → CAT 7 from Fontaine
//   - walking the whole way
// UVA ride time comes free from TransLoc: when the SAME bus has an arrival time at both
// stops, the difference is the ride. Otherwise we estimate from distance ("about").

const WALK_SPEED = 1.3; // meters per second (about 3 mph)
const WALK_DETOUR = 1.3; // paths aren't straight lines: add 30%
const BUS_SPEED = 5; // meters per second including stops (about 11 mph), for estimates
const BUS_DETOUR = 1.4; // roads between stops aren't straight either
const MAX_WALK_TO_STOP_M = 900; // don't suggest stops more than ~10 min walk away
const LONG_TRIP_WALK_S = 30 * 60; // walking the whole way takes 30+ min: also look at farther stops
const FAR_WALK_TO_STOP_M = 1_500; // ...up to ~20 min walk away (the usual rules still decide if it's worth it)
const CAT_LATER_S = 60 * 60; // next CAT bus over an hour away: say when it is
const STOPS_PER_ROUTE_END = 2; // per route: its 2 closest stops at each end
const CATCH_MARGIN_S = 30; // arrive at the stop at least 30s before the bus
const MAX_BUS_OPTIONS = 3;
const MAX_SLOWER_THAN_WALK_S = 5 * 60; // hide buses more than 5 min slower than walking
const MAX_CAT_WALK_S = 15 * 60; // CAT: don't suggest walking more than 15 min to or from the bus
// A bus that isn't faster than walking is still shown if it spares your legs, but not when it
// barely does (e.g. "ride 1 stop, then walk 10 min"): it must save at least this much walking.
const MIN_WALK_SAVED_S = 3 * 60;
const NOT_FASTER_S = 60; // "not faster" = saves less than a minute

// "Prefer" on the trip card: fastest (default) | walk (less walking) | transfers (fewer transfers)
export const PREFERENCES = ['fastest', 'walk', 'transfers'];
const LESS_WALK_SLOWER_S = 20 * 60; // "less walking" also shows buses up to 20 min slower than walking
const FEWER_TRANSFERS_MUST_SAVE_S = 15 * 60; // "fewer transfers": a transfer must save 15+ min over one bus

// Transfers
const TRANSFER_MIN_TRIP_M = 2_400; // only look for transfers on trips longer than ~1.5 miles
const TRANSFER_BUFFER_S = 3 * 60; // at least 3 min between buses (UVA buses can run late)
const TRANSFER_MUST_SAVE_S = 3 * 60; // only show a transfer if it saves 3+ min over everything else
// Where UVA and CAT meet (found by testing on 2026-11-12). Matched by TransLoc stop name.
const TRANSFER_HUBS = [/Jefferson Park Ave @ West Complex/i, /Emmet St @ Central Grounds Garage/i];

export function metersBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(h));
}

// Free walking estimate (no Google call).
export const estimateWalkSeconds = (a, b) => Math.round((metersBetween(a, b) * WALK_DETOUR) / WALK_SPEED);

// Stops within walking distance, closest first.
function stopsInReach(point, stops, maxMeters = MAX_WALK_TO_STOP_M) {
  return stops
    .map((stop) => ({ stop, meters: metersBetween(point, stop) }))
    .filter((s) => s.meters <= maxMeters)
    .sort((a, b) => a.meters - b.meters);
}

// A route's closest few stops from a list (already sorted closest first).
const routeStops = (reach, routeId) => reach.filter((s) => s.stop.routeIds.includes(routeId)).slice(0, STOPS_PER_ROUTE_END);

// How many stops forward from `from` to `to` along a looping route (null if not on it).
// Routes are loops, so going "forward" can wrap around the end of the list.
function stopsForward(route, fromId, toId) {
  const list = route.stopIds;
  const n = list.length;
  let best = null;
  list.forEach((id, i) => {
    if (id !== fromId) return;
    for (let step = 1; step < n; step++) {
      if (list[(i + step) % n] === toId) {
        if (best === null || step < best.steps) best = { startIndex: i, steps: step };
        break;
      }
    }
  });
  return best;
}

// Rough ride time from the distance between the stops along the way.
function estimateRideSeconds(route, startIndex, steps, stopsById) {
  let meters = 0;
  for (let k = 0; k < steps; k++) {
    const a = stopsById.get(route.stopIds[(startIndex + k) % route.stopIds.length]);
    const b = stopsById.get(route.stopIds[(startIndex + k + 1) % route.stopIds.length]);
    if (a && b) meters += metersBetween(a, b);
  }
  return Math.round((meters * BUS_DETOUR) / BUS_SPEED + steps * 20); // +20s per stop
}

// Arrival countdowns for one route at one stop, adjusted to "seconds from now".
function busTimes(arrivalsEntry, routeId, now) {
  if (!arrivalsEntry) return [];
  const ageSecs = (now - arrivalsEntry.fetchedAt) / 1000;
  const forRoute = arrivalsEntry.data.find((a) => a.routeId === routeId);
  return (forRoute?.times || [])
    .map((t) => ({ vehicleId: t.vehicleId, seconds: Math.max(0, t.seconds - ageSecs) }))
    .sort((a, b) => a.seconds - b.seconds);
}

/**
 * Everything about the UVA network that doesn't change during one trip request.
 * getArrivals(stopId): Promise<{ data, fetchedAt }> (cached by the caller)
 */
function uvaNetwork(routes, stops, getArrivals) {
  const running = routes.filter((r) => r.isRunning && r.stopIds?.length);
  const runningIds = new Set(running.map((r) => r.id));
  const arrivals = new Map(); // stopId -> Promise, so each stop is fetched once per request
  return {
    running,
    stops,
    liveStops: stops.filter((s) => s.routeIds.some((id) => runningIds.has(id))),
    stopsById: new Map(stops.map((s) => [s.id, s])),
    arrivalsFor(id) {
      if (!arrivals.has(id)) {
        arrivals.set(id, getArrivals(id).catch((err) => {
          console.error('[trip] arrivals for stop', id, err.message);
          return null;
        }));
      }
      return arrivals.get(id);
    },
  };
}

/**
 * UVA bus options from one point to another (best per route, fastest first).
 * startDelay: seconds from now before you can start (e.g. still riding a CAT bus).
 * All times in the results are counted from NOW.
 */
// Candidate (get-on stop, get-off stop, route) combinations + their arrival times.
async function uvaCandidates(net, from, to, maxMeters) {
  const boardChoices = stopsInReach(from, net.liveStops, maxMeters);
  const alightChoices = stopsInReach(to, net.liveStops, maxMeters);

  // For each route: its closest stops near you x its closest stops near the place,
  // kept only if the bus goes from the first to the second.
  const candidates = [];
  for (const route of net.running) {
    for (const b of routeStops(boardChoices, route.id)) {
      for (const a of routeStops(alightChoices, route.id)) {
        if (a.stop.id === b.stop.id) continue;
        const path = stopsForward(route, b.stop.id, a.stop.id);
        if (path) candidates.push({ board: b, alight: a, route, path });
      }
    }
  }

  const ids = [...new Set(candidates.flatMap((c) => [c.board.stop.id, c.alight.stop.id]))];
  const arrivals = new Map(await Promise.all(ids.map(async (id) => [id, await net.arrivalsFor(id)])));
  // No stop in reach at one end: name the closest one anyway, for the card ("~23 min walk").
  const closestStops = [];
  if (!boardChoices.length) closestStops.push(closestStop(net, from, 'from'));
  if (!alightChoices.length) closestStops.push(closestStop(net, to, 'to'));
  return {
    candidates,
    arrivals,
    noNearbyStops: closestStops.length > 0,
    closestStops: closestStops.filter(Boolean),
  };
}

// The closest stop on a running route, however far: { side, id, name, walkSeconds } (null if none).
function closestStop(net, point, side) {
  const best = stopsInReach(point, net.liveStops, Infinity)[0];
  return best ? { side, id: best.stop.id, name: best.stop.name, walkSeconds: estimateWalkSeconds(point, best.stop) } : null;
}

// Ride time for one particular bus: TransLoc's time for the SAME bus at the get-off stop, or an estimate.
function rideFor(c, bus, arrivals, net, now) {
  const estimate = estimateRideSeconds(c.route, c.path.startIndex, c.path.steps, net.stopsById);
  const sameBusLater = busTimes(arrivals.get(c.alight.stop.id), c.route.id, now)
    .find((t) => t.vehicleId === bus.vehicleId && t.seconds > bus.seconds);
  if (sameBusLater) {
    const measured = sameBusLater.seconds - bus.seconds;
    if (measured < estimate * 3 + 120) return { seconds: measured, estimated: false }; // ignore a full extra loop
  }
  return { seconds: estimate, estimated: true };
}

const stopInfo = (s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng });

async function uvaOptions(net, from, to, now, startDelay = 0, maxMeters = MAX_WALK_TO_STOP_M) {
  const { candidates, arrivals, noNearbyStops, closestStops } = await uvaCandidates(net, from, to, maxMeters);
  const found = [];
  for (const c of candidates) {
    const walkToStop = estimateWalkSeconds(from, c.board.stop);
    const walkFromStop = estimateWalkSeconds(c.alight.stop, to);

    // The first bus on this route you can still catch after (waiting and) walking to the stop.
    const times = busTimes(arrivals.get(c.board.stop.id), c.route.id, now);
    const bus = times.find((t) => t.seconds >= startDelay + walkToStop + CATCH_MARGIN_S);
    if (!bus) {
      // No live time we can catch. TransLoc often has none for a bus parked at the START of its
      // route (e.g. Purple Line at Fontaine), so estimate instead of giving up: assume the worst
      // case, a full gap between buses after you reach the stop.
      if (/pre-?\s*6\s*pm/i.test(c.route.note || '') && localHour(now) >= 18) continue;
      // Only when we're confident buses are really coming: the stop is where the route starts,
      // or TransLoc shows this route's buses coming at the get-off stop.
      const startsHere = c.path.startIndex === 0;
      const comingAlong = busTimes(arrivals.get(c.alight.stop.id), c.route.id, now).length > 0;
      if (!startsHere && !comingAlong) continue;
      const gap = typicalGap(times);
      const atStop = startDelay + walkToStop + CATCH_MARGIN_S;
      const busIn = Math.max(atStop, times.at(-1)?.seconds ?? 0) + gap;
      const ride = estimateRideSeconds(c.route, c.path.startIndex, c.path.steps, net.stopsById);
      found.push({
        type: 'bus',
        route: { id: c.route.id, name: c.route.name, color: c.route.color },
        board: { id: c.board.stop.id, name: c.board.stop.name, lat: c.board.stop.lat, lng: c.board.stop.lng },
        alight: { id: c.alight.stop.id, name: c.alight.stop.name, lat: c.alight.stop.lat, lng: c.alight.stop.lng },
        walkToStopSeconds: walkToStop,
        estimated: true, // no live time yet: "every ~X min"
        headwaySeconds: gap,
        busInSeconds: Math.round(busIn),
        waitSeconds: Math.round(busIn - startDelay - walkToStop),
        rideSeconds: Math.round(ride),
        rideEstimated: true,
        stopsCount: c.path.steps,
        walkFromStopSeconds: walkFromStop,
        totalSeconds: Math.round(busIn + ride + walkFromStop),
      });
      continue;
    }

    const { seconds: rideSeconds, estimated: rideEstimated } = rideFor(c, bus, arrivals, net, now);

    found.push({
      type: 'bus',
      route: { id: c.route.id, name: c.route.name, color: c.route.color },
      board: { id: c.board.stop.id, name: c.board.stop.name, lat: c.board.stop.lat, lng: c.board.stop.lng },
      alight: { id: c.alight.stop.id, name: c.alight.stop.name, lat: c.alight.stop.lat, lng: c.alight.stop.lng },
      walkToStopSeconds: walkToStop,
      vehicleId: bus.vehicleId, // which bus (for rider reports like "packed")
      busInSeconds: Math.round(bus.seconds), // from now
      waitSeconds: Math.round(bus.seconds - startDelay - walkToStop),
      rideSeconds: Math.round(rideSeconds),
      rideEstimated,
      stopsCount: c.path.steps,
      walkFromStopSeconds: walkFromStop,
      totalSeconds: Math.round(bus.seconds + rideSeconds + walkFromStop),
    });
  }
  return { options: bestPerKey(found, (o) => o.route.id), noNearbyStops, closestStops };
}

/**
 * "Arrive by" for UVA buses: the LATEST you can leave and still arrive by `target` (seconds from now).
 * Live when TransLoc already knows a bus that fits; otherwise an estimate (TransLoc only knows
 * buses coming soon): travel time + a worst-case wait of one gap between buses on that route.
 */
async function uvaArriveBy(net, from, to, now, target, maxMeters = MAX_WALK_TO_STOP_M) {
  const { candidates, arrivals, noNearbyStops, closestStops } = await uvaCandidates(net, from, to, maxMeters);
  const found = [];
  for (const c of candidates) {
    const walkToStop = estimateWalkSeconds(from, c.board.stop);
    const walkFromStop = estimateWalkSeconds(c.alight.stop, to);
    const times = busTimes(arrivals.get(c.board.stop.id), c.route.id, now);
    if (!times.length) continue; // route not coming here at all right now

    const base = {
      type: 'bus',
      route: { id: c.route.id, name: c.route.name, color: c.route.color, note: c.route.note || '' },
      board: stopInfo(c.board.stop),
      alight: stopInfo(c.alight.stop),
      walkToStopSeconds: walkToStop,
      stopsCount: c.path.steps,
      walkFromStopSeconds: walkFromStop,
    };

    // Live: the last known bus you can catch that still gets you there in time.
    const fits = times
      .filter((t) => t.seconds >= walkToStop + CATCH_MARGIN_S)
      .map((t) => ({ t, ride: rideFor(c, t, arrivals, net, now) }))
      .filter(({ t, ride }) => t.seconds + ride.seconds + walkFromStop <= target);
    const lastKnown = times.at(-1).seconds;
    const gap = typicalGap(times);
    const rideGuess = fits.at(-1)?.ride || rideFor(c, times.at(-1), arrivals, net, now);

    if (lastKnown + gap + rideGuess.seconds + walkFromStop < target) {
      // The time is past what TransLoc can see: estimate.
      // Routes marked "Pre-6PM" don't run in the evening, so don't promise them then.
      if (/pre-?\s*6\s*pm/i.test(c.route.note || '') && localHour(now + target * 1000) >= 18) continue;
      const atStop = target - walkFromStop - rideGuess.seconds - gap; // be at the stop by here
      found.push({
        ...base,
        estimated: true,
        headwaySeconds: gap,
        rideSeconds: Math.round(rideGuess.seconds),
        rideEstimated: true,
        leaveBySeconds: Math.round(atStop - walkToStop - CATCH_MARGIN_S),
        arriveSeconds: Math.round(target),
      });
    } else if (fits.length) {
      const { t, ride } = fits.at(-1);
      found.push({
        ...base,
        estimated: false,
        vehicleId: t.vehicleId,
        busInSeconds: Math.round(t.seconds),
        rideSeconds: Math.round(ride.seconds),
        rideEstimated: ride.estimated,
        leaveBySeconds: Math.round(t.seconds - walkToStop - CATCH_MARGIN_S),
        arriveSeconds: Math.round(t.seconds + ride.seconds + walkFromStop),
      });
    }
  }
  // Latest leave time first, one per route.
  const best = new Map();
  for (const o of found.sort((a, b) => b.leaveBySeconds - a.leaveBySeconds)) if (!best.has(o.route.id)) best.set(o.route.id, o);
  return { options: [...best.values()], noNearbyStops, closestStops };
}

// Hour of the day in Charlottesville (0-23) for a clock time.
function localHour(ms) {
  return Number(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }));
}

// How often buses come on a route at a stop, from the gaps between known arrivals (5-30 min).
function typicalGap(times) {
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i].seconds - times[i - 1].seconds);
  const sorted = gaps.filter((g) => g > 60).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 15 * 60;
  return Math.min(30 * 60, Math.max(5 * 60, median));
}

/**
 * Plan trip options.
 *   from, to: { lat, lng }
 *   routes, stops: from TransLoc (or the demo recording)
 *   getArrivals(stopId): Promise<{ data, fetchedAt }>
 *   getDirectWalk(): Promise<{ seconds, estimated }>
 *   getCat(a, b, leaveAtMs?, arriveByMs?): Promise<{ options: [...] from google.getTransit, status: 'ok' | 'limit' | 'error' }>
 *   arriveByMs: optional clock time (ms) to arrive by. Then options say when to LEAVE.
 */
export async function planTrip({ from, to, routes, stops, getArrivals, getDirectWalk, getCat, arriveByMs, prefer = 'fastest' }) {
  const now = Date.now();
  const net = uvaNetwork(routes, stops, getArrivals);
  if (!PREFERENCES.includes(prefer)) prefer = 'fastest';
  if (arriveByMs) return planArriveBy({ from, to, net, now, getDirectWalk, getCat, arriveByMs, prefer });

  const catPromise = getCat(from, to); // ask Google for CAT while we work out the UVA options
  const walk = await getDirectWalk();
  const options = [{ type: 'walk', totalSeconds: walk.seconds, estimated: walk.estimated, polyline: walk.polyline || '' }];
  const slack = prefer === 'walk' ? LESS_WALK_SLOWER_S : MAX_SLOWER_THAN_WALK_S;
  const worthIt = (o) => o.totalSeconds <= walk.seconds + slack
    && !(o.totalSeconds > walk.seconds - NOT_FASTER_S && sparesTooLittleWalking(o, walk.seconds));

  const uva = await uvaOptions(net, from, to, now, 0, stopReach(walk.seconds));
  options.push(...uva.options.filter(worthIt).slice(0, MAX_BUS_OPTIONS));

  // CAT (city buses, from Google's schedules), same rules.
  const cat = await catPromise;
  const catOptions = (cat.options || []).map((o) => catOption(o, now)).filter(Boolean);
  options.push(...bestPerKey(catOptions.filter(worthIt), (o) => o.lines.map((l) => l.name).join('>')).slice(0, MAX_BUS_OPTIONS));

  // UVA ↔ CAT transfers: long trips only, and only if clearly faster than everything else.
  if (metersBetween(from, to) >= TRANSFER_MIN_TRIP_M && cat.status === 'ok') {
    const bestSoFar = Math.min(...options.map((o) => o.totalSeconds));
    const transfers = await planTransfers({ net, from, to, now, getCat });
    const best = transfers.sort((a, b) => a.totalSeconds - b.totalSeconds)[0];
    if (best && best.totalSeconds <= bestSoFar - TRANSFER_MUST_SAVE_S) options.push(best);
  }

  options.forEach(annotate);
  const shown = fewerTransfersFilter(options, prefer, (o) => -o.totalSeconds).sort(sorter(prefer, (o) => o.totalSeconds));

  return {
    options: shown,
    prefer,
    catStatus: cat.status,
    catNextAt: catNextAt(cat, shown, now),
    noNearbyStops: uva.noNearbyStops,
    closestStops: uva.closestStops,
    busesRunning: net.running.length > 0,
    computedAt: now,
  };
}

// Long walks: also look at stops farther away (a bus there can still save a lot of walking).
const stopReach = (walkSeconds) => (walkSeconds >= LONG_TRIP_WALK_S ? FAR_WALK_TO_STOP_M : MAX_WALK_TO_STOP_M);

// No CAT option shown and Google's next CAT bus is over an hour away (e.g. Sundays): when it leaves.
function catNextAt(cat, shown, now) {
  if (cat.status !== 'ok' || shown.some((o) => o.type === 'cat' || o.type === 'transfer')) return undefined;
  const next = Math.min(...(cat.options || []).map((o) => o.departAt).filter(Number.isFinite));
  return Number.isFinite(next) && next - now > CAT_LATER_S * 1000 ? next : undefined;
}

// ---------- "Arrive by" mode ----------

// Every option says when to leave (latest first). Transfers are left out on purpose.
async function planArriveBy({ from, to, net, now, getDirectWalk, getCat, arriveByMs, prefer }) {
  const target = (arriveByMs - now) / 1000; // seconds from now
  const catPromise = getCat(from, to, undefined, arriveByMs);
  const walk = await getDirectWalk();

  const options = [{
    type: 'walk',
    totalSeconds: walk.seconds,
    estimated: walk.estimated,
    polyline: walk.polyline || '',
    leaveBySeconds: Math.round(target - walk.seconds),
    arriveSeconds: Math.round(target),
  }];
  // A bus is only worth it if it lets you leave no more than 5 min earlier than walking would.
  const walkLeave = options[0].leaveBySeconds;
  const worthIt = (o) => o.leaveBySeconds >= walkLeave - (prefer === 'walk' ? LESS_WALK_SLOWER_S : MAX_SLOWER_THAN_WALK_S)
    && !(o.leaveBySeconds < walkLeave + NOT_FASTER_S && sparesTooLittleWalking(o, walk.seconds));

  const uva = await uvaArriveBy(net, from, to, now, target, stopReach(walk.seconds));
  options.push(...uva.options.map(withTotal).filter(worthIt).slice(0, MAX_BUS_OPTIONS));

  const cat = await catPromise;
  const catOptions = (cat.options || [])
    .filter((o) => o.arriveAt <= arriveByMs + 60_000) // Google may include trips arriving a bit late
    .map((o) => catOption(o, now))
    .filter(Boolean)
    .map((o) => withTotal({ ...o, leaveBySeconds: o.busInSeconds - o.walkToStopSeconds - CATCH_MARGIN_S, arriveSeconds: o.totalSeconds }));
  const latestPerLine = new Map();
  for (const o of catOptions.sort((a, b) => b.leaveBySeconds - a.leaveBySeconds)) {
    const key = o.lines.map((l) => l.name).join('>');
    if (!latestPerLine.has(key)) latestPerLine.set(key, o);
  }
  options.push(...[...latestPerLine.values()].filter(worthIt).slice(0, MAX_BUS_OPTIONS));

  // UVA ↔ CAT transfers, worked out backwards from the arrival time. Long trips only,
  // and only if they let you leave 3+ min later than everything else.
  if (metersBetween(from, to) >= TRANSFER_MIN_TRIP_M && cat.status === 'ok') {
    const latestSoFar = Math.max(...options.map((o) => o.leaveBySeconds));
    const transfers = await planTransfersArriveBy({ net, from, to, now, getCat, arriveByMs, target });
    const best = transfers.sort((a, b) => b.leaveBySeconds - a.leaveBySeconds)[0];
    if (best && best.leaveBySeconds >= latestSoFar + TRANSFER_MUST_SAVE_S) options.push(best);
  }

  // Only options you can still make (leaving within the next minute counts as "leave now").
  options.forEach(annotate);
  const possible = fewerTransfersFilter(options.filter((o) => o.leaveBySeconds >= -60), prefer, (o) => o.leaveBySeconds)
    .sort(sorter(prefer, (o) => -o.leaveBySeconds));

  return {
    options: possible,
    prefer,
    arriveBy: arriveByMs,
    tooLate: possible.length === 0,
    catStatus: cat.status,
    noNearbyStops: uva.noNearbyStops,
    closestStops: uva.closestStops,
    busesRunning: net.running.length > 0,
    computedAt: now,
  };
}

// Transfers in arrive-by mode: start from the arrival time and work backwards.
async function planTransfersArriveBy({ net, from, to, now, getCat, arriveByMs, target }) {
  const hubs = TRANSFER_HUBS
    .map((re) => net.liveStops.find((s) => re.test(s.name)))
    .filter(Boolean)
    .map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng }));
  const results = await Promise.all(hubs.flatMap((hub) => [uvaThenCat(hub), catThenUva(hub)]));
  return results.filter(Boolean);

  // Latest CAT trip from a to b that arrives by `byMs` and leaves after `earliest` seconds from now.
  async function latestCat(a, b, byMs) {
    const res = await getCat(a, b, undefined, byMs);
    if (res.status !== 'ok') return null;
    return res.options
      .filter((o) => o.arriveAt <= byMs + 60_000)
      .map((o) => catOption(o, now))
      .filter(Boolean)
      .sort((x, y) => y.busInSeconds - x.busInSeconds)[0] || null;
  }

  // UVA bus to the hub, then CAT to the destination.
  async function uvaThenCat(hub) {
    if (metersBetween(from, hub) < 400) return null;
    if (!(await uvaOptions(net, from, hub, now)).options.length) return null; // free check first
    const catLeg = await latestCat(hub, to, arriveByMs);
    if (!catLeg) return null;
    // Be at the hub, with a buffer, before walking to the CAT stop.
    const hubBy = catLeg.busInSeconds - catLeg.walkToStopSeconds - TRANSFER_BUFFER_S;
    const uvaLeg = (await uvaArriveBy(net, from, hub, now, hubBy)).options[0];
    if (!uvaLeg) return null;
    return {
      type: 'transfer',
      direction: 'uva-cat',
      hub,
      uva: uvaLeg,
      cat: catLeg,
      changeWaitSeconds: Math.max(0, Math.round(catLeg.busInSeconds - catLeg.walkToStopSeconds - uvaLeg.arriveSeconds)),
      leaveBySeconds: uvaLeg.leaveBySeconds,
      arriveSeconds: catLeg.totalSeconds,
      totalSeconds: Math.round(catLeg.totalSeconds - uvaLeg.leaveBySeconds),
      computedAt: now,
    };
  }

  // CAT to the hub, then a UVA bus to the destination.
  async function catThenUva(hub) {
    if (metersBetween(hub, to) < 400) return null;
    const uvaLeg = (await uvaArriveBy(net, hub, to, now, target)).options[0]; // free
    if (!uvaLeg) return null;
    const hubBy = uvaLeg.leaveBySeconds + CATCH_MARGIN_S - TRANSFER_BUFFER_S; // seconds from now
    const catLeg = await latestCat(from, hub, now + hubBy * 1000);
    if (!catLeg) return null;
    const leaveBy = catLeg.busInSeconds - catLeg.walkToStopSeconds - CATCH_MARGIN_S;
    return {
      type: 'transfer',
      direction: 'cat-uva',
      hub,
      uva: uvaLeg,
      cat: catLeg,
      changeWaitSeconds: Math.max(0, Math.round(uvaLeg.leaveBySeconds + CATCH_MARGIN_S - catLeg.totalSeconds)),
      leaveBySeconds: leaveBy,
      arriveSeconds: uvaLeg.arriveSeconds,
      totalSeconds: Math.round(uvaLeg.arriveSeconds - leaveBy),
      computedAt: now,
    };
  }
}

// "Door to door" time for an arrive-by option.
const withTotal = (o) => ({ ...o, totalSeconds: Math.round(o.arriveSeconds - o.leaveBySeconds) });

// ---------- Transfers ----------

// Tries every transfer stop in both directions. Free checks (UVA) run first,
// so Google is only asked when a UVA half actually exists.
async function planTransfers({ net, from, to, now, getCat }) {
  const hubs = TRANSFER_HUBS
    .map((re) => net.liveStops.find((s) => re.test(s.name)))
    .filter(Boolean)
    .map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng }));

  const results = await Promise.all(hubs.flatMap((hub) => [uvaThenCat(hub), catThenUva(hub)]));
  return results.filter(Boolean);

  // UVA bus to the hub, then CAT from the hub.
  async function uvaThenCat(hub) {
    if (metersBetween(from, hub) < 400) return null; // you're already at the hub: that's just CAT
    const first = (await uvaOptions(net, from, hub, now)).options[0];
    if (!first) return null;
    const atHub = first.totalSeconds; // seconds from now
    const second = await getCat(hub, to, now + (atHub + TRANSFER_BUFFER_S) * 1000);
    const catLeg = bestCat(second, now, atHub + TRANSFER_BUFFER_S);
    if (!catLeg) return null;
    return transferOption('uva-cat', hub, first, catLeg, now);
  }

  // CAT to the hub, then a UVA bus from the hub.
  async function catThenUva(hub) {
    if (metersBetween(hub, to) < 400) return null; // the hub is the destination: that's just CAT
    // Free check first: does any UVA route go from the hub toward the destination at all?
    if (!(await uvaOptions(net, hub, to, now)).options.length) return null;
    const first = bestCat(await getCat(from, hub), now, 0);
    if (!first) return null;
    const atHub = first.totalSeconds;
    const second = (await uvaOptions(net, hub, to, now, atHub + TRANSFER_BUFFER_S - CATCH_MARGIN_S)).options[0];
    if (!second) return null;
    return transferOption('cat-uva', hub, first, second, now);
  }
}

// The CAT option that arrives first, if you can only start `startDelay` seconds from now.
function bestCat(result, now, startDelay) {
  if (result.status !== 'ok') return null;
  return result.options
    .map((o) => catOption(o, now, startDelay))
    .filter(Boolean)
    .sort((a, b) => a.totalSeconds - b.totalSeconds)[0] || null;
}

function transferOption(direction, hub, first, second, now) {
  const [uvaLeg, catLeg] = direction === 'uva-cat' ? [first, second] : [second, first];
  // Wait at the hub: from arriving there to the second bus leaving.
  const changeWait = direction === 'uva-cat'
    ? catLeg.busInSeconds - first.totalSeconds - catLeg.walkToStopSeconds
    : uvaLeg.busInSeconds - first.totalSeconds - uvaLeg.walkToStopSeconds;
  return {
    type: 'transfer',
    direction,
    hub,
    uva: uvaLeg,
    cat: catLeg,
    changeWaitSeconds: Math.max(0, Math.round(changeWait)),
    totalSeconds: second.totalSeconds,
    computedAt: now,
  };
}

// Adds footSeconds (all walking) and transfers (how many bus changes) to an option.
function annotate(o) {
  if (o.type === 'walk') {
    o.footSeconds = o.totalSeconds;
    o.transfers = 0;
  } else if (o.type === 'bus') {
    o.footSeconds = o.walkToStopSeconds + o.walkFromStopSeconds;
    o.transfers = 0;
  } else if (o.type === 'cat') {
    o.footSeconds = o.walkToStopSeconds + o.walkFromStopSeconds;
    o.transfers = Math.max(0, (o.lines?.length || 1) - 1);
  } else if (o.type === 'transfer') {
    o.footSeconds = o.uva.walkToStopSeconds + o.uva.walkFromStopSeconds + o.cat.walkToStopSeconds + o.cat.walkFromStopSeconds;
    o.transfers = 1 + Math.max(0, (o.cat.lines?.length || 1) - 1);
  }
  return o;
}

// Order of the list. base(o): smaller = better for "fastest" (arrive sooner / leave later).
function sorter(prefer, base) {
  // Walking compared in whole minutes: a few seconds less walking shouldn't beat arriving sooner.
  if (prefer === 'walk') return (a, b) => Math.round(a.footSeconds / 60) - Math.round(b.footSeconds / 60) || base(a) - base(b);
  if (prefer === 'transfers') return (a, b) => a.transfers - b.transfers || base(a) - base(b);
  return (a, b) => base(a) - base(b);
}

// "Fewer transfers": when a one-bus way exists, only keep trips with changes if they're
// 15+ min better. score(o): bigger = better (minus arrival time, or leave-by time).
function fewerTransfersFilter(options, prefer, score) {
  if (prefer !== 'transfers') return options;
  const direct = options.filter((o) => o.type !== 'walk' && o.transfers === 0);
  if (!direct.length) return options;
  const bestDirect = Math.max(...direct.map(score));
  return options.filter((o) => o.transfers === 0 || score(o) >= bestDirect + FEWER_TRANSFERS_MUST_SAVE_S);
}

// True when a bus option still makes you walk almost as much as walking the whole way.
function sparesTooLittleWalking(o, walkSeconds) {
  return walkSeconds - (o.walkToStopSeconds + o.walkFromStopSeconds) < MIN_WALK_SAVED_S;
}

// Fastest option for each key (e.g. one per route), fastest first.
function bestPerKey(list, keyOf) {
  const best = new Map();
  for (const o of [...list].sort((a, b) => a.totalSeconds - b.totalSeconds)) {
    if (!best.has(keyOf(o))) best.set(keyOf(o), o);
  }
  return [...best.values()];
}

// Turns a Google CAT result (real clock times) into "seconds from now".
// Drops buses you can no longer catch (cached answers can be up to 5 minutes old).
// startDelay: seconds from now before you can start walking to the CAT stop.
function catOption(o, now, startDelay = 0) {
  const busIn = (o.departAt - now) / 1000;
  if (busIn < startDelay + o.walkBeforeSeconds + CATCH_MARGIN_S) return null;
  if (o.walkBeforeSeconds > MAX_CAT_WALK_S || o.walkAfterSeconds > MAX_CAT_WALK_S) return null;
  return {
    type: 'cat',
    lines: o.lines,
    board: o.board,
    alight: o.alight,
    stopsCount: o.stopsCount,
    walkToStopSeconds: o.walkBeforeSeconds,
    busInSeconds: Math.round(busIn),
    waitSeconds: Math.round(busIn - startDelay - o.walkBeforeSeconds),
    rideSeconds: o.rideSeconds,
    walkFromStopSeconds: o.walkAfterSeconds,
    totalSeconds: Math.round((o.arriveAt - now) / 1000),
    polyline: o.polyline,
  };
}
