// Fills in real locations for server/places.json by asking Google (never guessing).
//   npm run places           -> looks up only places that have no location yet
//   npm run places -- ohill  -> re-looks up specific places (e.g. after fixing a 'query')
// Uses Places Text Search: about 1 call per place (free tier: 5,000/month).

import { readFile, writeFile } from 'node:fs/promises';

const KEY = process.env.GOOGLE_SERVER_KEY;
if (!KEY) {
  console.error('Missing GOOGLE_SERVER_KEY in .env');
  process.exit(1);
}

const file = new URL('../server/places.json', import.meta.url);
const data = JSON.parse(await readFile(file, 'utf8'));
const only = process.argv.slice(2);
const todo = data.places.filter((p) => (only.length ? only.includes(p.id) : !p.location));

if (!todo.length) {
  console.log('Nothing to look up. (To redo one: npm run places -- <id>)');
  process.exit(0);
}
console.log(`Looking up ${todo.length} place(s) with Google...\n`);

for (const p of todo) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.formattedAddress,places.businessStatus',
    },
    body: JSON.stringify({
      textQuery: p.query,
      pageSize: 1,
      locationBias: { circle: { center: { latitude: 38.0336, longitude: -78.508 }, radius: 20000 } },
    }),
  });
  const json = await res.json();
  const hit = json.places?.[0];
  if (!res.ok || !hit) {
    console.log(`  ✗ ${p.id.padEnd(14)} not found (${res.status}). Fix its "query" and retry.`);
    continue;
  }
  p.location = { lat: +hit.location.latitude.toFixed(6), lng: +hit.location.longitude.toFixed(6) };
  p.address = hit.formattedAddress.replace(/, USA$/, '');
  p.googleName = hit.displayName?.text || '';
  p.googlePlaceId = hit.id;
  const closed = hit.businessStatus === 'CLOSED_PERMANENTLY';
  console.log(`  ${closed ? '⚠ CLOSED' : '✓'} ${p.id.padEnd(14)} -> ${p.googleName} | ${p.address}`);
  console.log(`    ${''.padEnd(14)}    https://www.google.com/maps?q=${p.location.lat},${p.location.lng}`);
}

// Write back with one place per line so the file stays easy to read and edit.
const lines = data.places.map((p) => '    ' + JSON.stringify(p));
const out = `{\n  "_readme": ${JSON.stringify(data._readme)},\n  "places": [\n${lines.join(',\n')}\n  ]\n}\n`;
await writeFile(file, out);
console.log('\nSaved server/places.json. Open the map links above to check each pin.');
