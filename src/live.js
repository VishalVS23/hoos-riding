// Live bus facts from our server that several parts of the app use (map popups, trip card).
// Parked buses: sitting in one spot 4+ min (layover / driver break). See server/parked.js.

let parked = new Map(); // vehicleId -> { routeId, sinceMs, stopId, stopName, atRouteStart }

export function setParked(list) {
  parked = new Map((list || []).map((p) => [p.vehicleId, p]));
}

export const parkedInfo = (vehicleId) => (vehicleId == null ? null : parked.get(vehicleId) || null);

// "6 min at JPJ South Lot (likely a layover or driver break)"
export function parkedDetail(p) {
  const minutes = Math.max(4, Math.round((Date.now() - p.sinceMs) / 60_000));
  const where = p.stopName ? ` at ${p.stopName}` : '';
  const why = p.atRouteStart ? ' (likely a layover or driver break)' : '';
  return `${minutes} min${where}${why}`;
}
