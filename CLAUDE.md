# HooMaps: notes for Claude Code

HooMaps is an unofficial, non-commercial UVA + CAT bus web app (PWA). See [README.md](README.md) for features and [docs/SETUP.md](docs/SETUP.md) for setup. The maintainer's personal plan lives in `CLAUDE.local.md` (not in the repo).

## House rules

- Explain changes in plain English; many contributors are new to coding.
- One feature at a time; show a short plan before big changes.
- **Never put keys in code.** Keys live in `.env` (git-ignored). Never give a server-only key a `VITE_` name (Vite ships those to every browser).
- Phones never call TransLoc, Google Places or Google Routes directly: everything goes through the Express server, which caches and enforces daily/monthly caps (`server/google.js`). Keep it that way, and flag anything that could cost money.
- Poll TransLoc politely (every 5 s, only while someone is watching). Don't commit recorded TransLoc data (`demo/recording*.json`, `samples/*.json` are git-ignored).
- Privacy: never show or store riders' locations. Devices are random IDs, stored only as salted hashes.
- Plain JavaScript + Vite, no framework. Prefer simple, well-known tools; pin new dependencies to a version that's been out a while.

## Map of the code

- `src/main.js`: map, buses, routes, stops (start here). `src/search.js`: search + trip card. `src/classes.js`, `src/ics.js`: My classes + SIS import. `src/notify.js`: reminders. `src/reports.js`: rider reports. `src/eta.js`: Share my ETA. Colors are CSS variables at the top of `src/style.css`.
- `server/index.js`: all `/api/...` addresses. `server/trips.js`: trip planning. `server/google.js`: Google calls, caps, caching. `server/places.json`: UVA places + nicknames (`npm run places` fills locations from Google; always check the printed map links). `server/reports.js`, `server/bunching.js`, `server/parked.js`, `server/reminders.js`, `server/shares.js`, `server/push.js`, `server/db.js` (Supabase over plain REST; schema in `supabase/schema.sql`).

## Gotchas

- The service worker (`public/sw.js`) and push only run in the built app (`npm run build && npm run preview`), not `npm run dev`.
- Google Maps overrides `position` on the map box; it's sized with `height: 100dvh`.
- Don't reuse map-marker class names (e.g. `.bus`) on other elements.
- Set `color-scheme` explicitly in CSS, or Google's popup close button can vanish in dark mode.
- TransLoc's `GetStopArrivalTimes` only accepts one stop per request. Its vehicle `TimeStamp` is ~7 h off.
- `render.yaml` `name` must stay as is (the Render Blueprint manages the live service by that name).
