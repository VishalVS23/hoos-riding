// Records real bus data for demo mode.
// Run with:  npm run record          (30 minutes)
//       or:  npm run record -- 5     (5 minutes, for a quick test)
//       or:  npm run record -- 90 gameday   (90 minutes, saved as demo/recording-gameday.json)
// Saves to demo/recording.json (also saved every minute, so stopping early keeps what you have).
// Only demo/recording.json is replayed by ?demo; other names are kept for later (e.g. game-day mode).
// Best time to record: a weekday late morning, when every line is running.

import { mkdir, writeFile } from 'node:fs/promises';
import { fetchVehicles, fetchRoutesAndStops, fetchArrivals } from '../server/transloc.js';

const MINUTES = Number(process.argv[2]) || 30;
const VEHICLES_EVERY_MS = 5_000; // same pace as one normal app user
const ARRIVALS_EVERY_MS = 2_000; // one stop at a time, gently
const SAVE_EVERY_MS = 60_000;

const outDir = new URL('../demo/', import.meta.url);
const label = (process.argv[3] || '').replace(/[^a-z0-9-]/gi, '').toLowerCase();
const fileName = label ? `recording-${label}.json` : 'recording.json';
const outFile = new URL(fileName, outDir);

const start = Date.now();
const durationMs = MINUTES * 60_000;
const elapsed = () => Date.now() - start;

console.log(`Recording ${MINUTES} min of UVA bus data. Keep this window open and the laptop awake.`);

const { routes, stops } = await fetchRoutesAndStops();
const running = new Set(routes.filter((r) => r.isRunning).map((r) => r.id));
const activeStops = stops.filter((s) => s.routeIds.some((id) => running.has(id)));
console.log(`${running.size} routes running, ${activeStops.length} stops to watch.`);

const recording = {
  recordedAt: new Date(start).toISOString(),
  durationMs,
  routes,
  stops,
  vehicleFrames: [], // [{ t, vehicles }]
  arrivals: {}, // stopId -> [{ t, arrivals }]
};

async function save() {
  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, JSON.stringify({ ...recording, durationMs: Math.min(durationMs, elapsed()) }));
}

// Bus positions every 5 seconds.
async function recordVehicles() {
  try {
    recording.vehicleFrames.push({ t: elapsed(), vehicles: await fetchVehicles() });
  } catch (err) {
    console.error('  (skipped a bus snapshot:', err.message + ')');
  }
}

// Arrival times: one stop every 2 seconds, cycling through all of them.
let stopIndex = 0;
async function recordNextStop() {
  if (!activeStops.length) return;
  const stop = activeStops[stopIndex++ % activeStops.length];
  try {
    const arrivals = await fetchArrivals(stop.id);
    (recording.arrivals[stop.id] ||= []).push({ t: elapsed(), arrivals });
  } catch (err) {
    console.error(`  (skipped stop ${stop.id}:`, err.message + ')');
  }
}

await recordVehicles();
const timers = [
  setInterval(recordVehicles, VEHICLES_EVERY_MS),
  setInterval(recordNextStop, ARRIVALS_EVERY_MS),
  setInterval(async () => {
    await save();
    const mins = Math.floor(elapsed() / 60_000);
    const buses = recording.vehicleFrames.at(-1)?.vehicles.length ?? 0;
    console.log(`  ${mins}/${MINUTES} min recorded · ${buses} buses on the road · saved`);
  }, SAVE_EVERY_MS),
];

setTimeout(async () => {
  timers.forEach(clearInterval);
  await save();
  console.log(`Done! Saved ${recording.vehicleFrames.length} bus snapshots to demo/${fileName}`);
}, durationMs);
