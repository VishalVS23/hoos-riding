// Demo mode: replays a recording of real bus data (demo/recording.json) in a loop.
// Used when the app is opened with ?demo, e.g. https://hoos-riding.onrender.com/?demo
// Every demo viewer sees the same moment of the loop, and times are shifted to "now".

import { readFile } from 'node:fs/promises';

const RECORDING_URL = new URL('../demo/recording.json', import.meta.url);

let recording = null;

export async function loadRecording() {
  try {
    recording = JSON.parse(await readFile(RECORDING_URL, 'utf8'));
    const minutes = Math.round(recording.durationMs / 60_000);
    console.log(
      `[demo] loaded recording from ${recording.recordedAt}: ${minutes} min, ` +
        `${recording.vehicleFrames.length} bus snapshots`,
    );
  } catch (err) {
    recording = null;
    if (err.code !== 'ENOENT') console.error('[demo] could not read recording:', err.message);
    else console.log('[demo] no recording yet (run: npm run record)');
  }
}

export const hasRecording = () => recording !== null;

// How far into the loop we are right now (milliseconds).
function loopPosition() {
  return Date.now() % recording.durationMs;
}

// The newest snapshot at or before this point in the loop (wrapping around if needed).
function latestBefore(snapshots, position) {
  let found = null;
  for (const snap of snapshots) {
    if (snap.t <= position) found = snap;
    else break;
  }
  if (found) return { snap: found, ageMs: position - found.t };
  // Before the first snapshot: use the last one from the previous loop.
  const last = snapshots.at(-1);
  return last ? { snap: last, ageMs: position + recording.durationMs - last.t } : null;
}

export function demoVehicles() {
  const { snap, ageMs } = latestBefore(recording.vehicleFrames, loopPosition());
  return { vehicles: snap.vehicles, fetchedAt: Date.now() - ageMs, error: null, demo: true };
}

export function demoRoutes() {
  return { routes: recording.routes, stops: recording.stops, demo: true };
}

export function demoStopExists(stopId) {
  return recording.stops.some((s) => s.id === stopId);
}

export function demoArrivals(stopId) {
  const snapshots = recording.arrivals[stopId] || [];
  const found = latestBefore(snapshots, loopPosition());
  if (!found) return { arrivals: [], fetchedAt: Date.now(), demo: true };

  // Drop buses that would already have come and gone since this snapshot.
  const ageSecs = found.ageMs / 1000;
  const arrivals = found.snap.arrivals.map((a) => ({
    ...a,
    times: a.times.filter((t) => t.seconds - ageSecs > -30),
  }));
  // The app subtracts the age itself, so countdowns keep ticking between snapshots.
  return { arrivals, fetchedAt: Date.now() - found.ageMs, demo: true };
}
