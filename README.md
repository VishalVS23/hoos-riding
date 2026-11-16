# HooMaps

**UVA and CAT buses, live, in one map.** A mobile-first web app for University of Virginia students: search by the names students actually use ("O-Hill", "Clem", "the Corner"), see whether a UVA bus, a CAT bus or walking gets you there fastest, and get a buzz when it's time to leave for class.

**Use it:** https://hoomaps.onrender.com. Open it on your phone and choose *Add to Home Screen* (iPhone: Share → Add to Home Screen). No App Store, no account.

> **Unofficial student project.** Not affiliated with, endorsed by or supported by the University of Virginia, UVA Parking & Transportation, Charlottesville Area Transit, or TransLoc / Ride Systems. Bus data comes from the public UVA tracker and may be wrong or missing. Non-commercial.

## Features

- **Live UVA buses** on a Google map, colored by route, updating every 5 seconds; route lines, route filter, tap a stop for arrival times, tap a bus to see how full it is.
- **Search with UVA nicknames** (`server/places.json`): 100+ places including every first-year dorm, academic buildings, dining and landmarks, plus bus stops by name.
- **Trip options side by side:** UVA buses, CAT buses (free), walking, and simple UVA ↔ CAT transfers, with a plain verdict ("Walking is faster right now"). Walking paths drawn on the map.
- **Leave now / Arrive by**, plus *Prefer:* fastest, less walking, fewer transfers.
- **My classes:** add classes by hand or import the `.ics` file from SIS; leave-by time for each class, starting from your previous class's building.
- **Leave-now reminders:** web push notification 2 minutes before you need to leave (iPhone: Home Screen app only).
- **Rider reports** (packed, broke down, detour…) checked against live data, with "Still there?" confirmations; reports expire.
- **Alerts:** bunched buses and buses parked for a while (layover / driver break).
- **Share my ETA:** a temporary link that follows your bus to your stop.
- Favorites, live location dot, dark mode, demo mode (`?demo` replays a recording you make with `npm run record`; none is included) and Cav mode (cartoon bus faces).

## Run it yourself

You only need this to work on the code. Students should just use the website.

**New to this? Follow the step-by-step guide: [docs/SETUP.md](docs/SETUP.md)** (installing the tools, getting each key, editing the code, hosting your own copy, troubleshooting). The short version:

**You need:** [Node.js](https://nodejs.org) 22.9 or newer, and Git.

```bash
git clone https://github.com/VishalVS23/hoos-riding.git
cd hoos-riding
npm install
cp .env.example .env     # then fill in .env (below)
npm run dev              # opens the app at http://localhost:5173
```

`npm run dev` starts both the website (Vite, port 5173) and the small Express server (port 3001).

### Settings (`.env`)

| Setting | Needed? | What it's for |
|---|---|---|
| `TRANSLOC_API_KEY` | Yes | The public key the UVA tracker page uses ([how to find it](docs/SETUP.md#4a-transloc-key-required-free-no-account)). The server won't start without it. |
| `VITE_GOOGLE_MAPS_KEY` | Yes | Google **Maps JavaScript API** key for the map. Restrict it to `http://localhost:5173/*`. |
| `VITE_GOOGLE_MAP_ID` | Optional | Your own Map ID (custom style). Blank = Google's demo map. |
| `GOOGLE_SERVER_KEY` | For search + trips | A second Google key for **Places API (New)** and **Routes API**. Server only. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Optional | Free [Supabase](https://supabase.com) database: rider reports, usage counts, reminders. Run [supabase/schema.sql](supabase/schema.sql) in its SQL Editor. Without it, data is kept in memory. |
| `ADMIN_PASSWORD` | Optional | Turns on the `/admin` page for removing bad reports (8+ characters). |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Optional | Push reminders. Make a pair with `npx web-push generate-vapid-keys`. Reminders only work in the built app (`npm run preview`), not `npm run dev`. |

> **Cost warning:** Google Maps Platform needs a billing account. Normal personal use fits in Google's free monthly amounts, and the server enforces its own daily and monthly caps (`server/google.js`) and caches answers, but **you are responsible for your own keys and bills**. Set a budget alert in Google Cloud. Never put a key in the code or give a server key a `VITE_` name (that would send it to every browser).

### Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Work on the app with live reload |
| `npm run build` then `npm run preview` | Test the real built app (service worker, push) |
| `npm run record -- 30` | Record 30 min of live buses to `demo/recording.json` for `?demo` |
| `npm run places` | Look up locations for new entries in `server/places.json` (uses Google) |
| `npm run icons` / `npm run cav` / `npm run qr` | Redraw the app icons / Cav mode faces / QR codes |

## How it works

```
Phone (PWA) ──/api/...──▶ Express server ──polls every 5 s──▶ UVA TransLoc tracker
                              │
                              ├──▶ Google Places + Routes (server key, caps, caching)
                              └──▶ Supabase (reports, usage counts, reminders)
```

Phones never call TransLoc, Places or Routes directly; only the server does, politely, and it only polls while someone has the app open. The browser only loads the map itself.

- `src/`: the website (plain JavaScript + Vite). Start at `src/main.js`.
- `server/`: the Express server. Start at `server/index.js`; trip planning is in `server/trips.js`.
- `CLAUDE.md`: house rules for working on this repo with [Claude Code](https://claude.com/claude-code), which this project was built with.

Bus recordings and raw TransLoc samples are not included in this repo (they're the tracker's data). Record your own with `npm run record`; see [samples/README.md](samples/README.md) for what each endpoint returns.

## Privacy

No accounts. Your location stays on your phone. Rider reports and reminders use a random ID per phone, stored only as a scrambled hash. Favorites and classes live on your phone, unless you turn on reminders (then your class days, times and buildings are stored on the server until you turn them off).

## Contributing

Found a wrong nickname, a missing building, or a bug? See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests are welcome.

## License

[MIT](LICENSE). Bus data belongs to its owners (UVA / TransLoc); map data © Google.
