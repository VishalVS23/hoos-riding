# Run HooMaps yourself: step-by-step guide

This guide is for anyone who wants to run HooMaps on their own computer, change it, or host their own copy. **You don't need any of this just to use the app.** Open https://hoomaps.onrender.com on your phone instead.

No coding experience is assumed. Plan on about **30-45 minutes** the first time, mostly creating free accounts.

**Contents**

1. [What you'll end up with](#1-what-youll-end-up-with)
2. [Install the tools](#2-install-the-tools)
3. [Download the code](#3-download-the-code)
4. [Get your keys](#4-get-your-keys)
5. [Fill in `.env`](#5-fill-in-env)
6. [Start the app](#6-start-the-app)
7. [Optional extras](#7-optional-extras-database-admin-page-reminders)
8. [Editing the code: where things live](#8-editing-the-code-where-things-live)
9. [Host your own copy online](#9-host-your-own-copy-online)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. What you'll end up with

HooMaps has two parts that run together on your computer:

| Part | What it is | Address |
|---|---|---|
| **Website** | What you see: the map, search, buttons (`src/` folder, built with Vite) | http://localhost:5173 |
| **Server** | A small helper that fetches bus data and talks to Google (`server/` folder, Express) | http://localhost:3001 (you won't open this directly) |

One command (`npm run dev`) starts both.

**What each key unlocks:**

| You set up… | You get… |
|---|---|
| TransLoc key + Google map key (**required**) | The map, live UVA buses, routes, stops, arrival times, demo mode |
| + Google server key | Search, trip options, CAT buses, walking times, class leave-by times |
| + Supabase (optional) | Rider reports and usage counts that survive restarts |
| + Admin password (optional) | The `/admin` page for removing bad reports |
| + Push keys (optional) | Leave-now class reminders |

---

## 2. Install the tools

You need three free programs. Install each with the default options.

1. **Node.js**, version 22.9 or newer: https://nodejs.org (pick the "LTS" download).
2. **Git**: https://git-scm.com/downloads
3. **A code editor** (recommended): [VS Code](https://code.visualstudio.com).

Check they worked: open a terminal (Windows: in VS Code press **Ctrl+`**, the key left of 1; Mac: the Terminal app) and run:

```bash
node --version   # should print v22.9 or higher
git --version    # any version is fine
```

---

## 3. Download the code

In the terminal, go to the folder where you keep projects, then:

```bash
git clone https://github.com/VishalVS23/hoos-riding.git
cd hoos-riding
npm install
```

`npm install` downloads the few building blocks the app uses into a `node_modules` folder (about a minute).

Then make your settings file from the example:

```bash
cp .env.example .env        # Mac / Linux / Git Bash
copy .env.example .env      # Windows Command Prompt or PowerShell
```

`.env` holds your private keys. Git ignores it, so it never gets uploaded. **Never paste keys into any other file.**

---

## 4. Get your keys

### 4a. TransLoc key (required, free, no account)

HooMaps reads the same live data as UVA's public bus tracker. That tracker page uses a public key you can see in your browser:

1. Open https://uva.transloc.com/routes in Chrome or Edge on a computer.
2. Press **F12** to open the developer tools, then click the **Network** tab.
3. Click **Fetch/XHR**, then reload the page (F5).
4. Click a request named **GetMapVehiclePoints**. In its address (the "Request URL"), find `apiKey=` and copy the text after it, up to the next `&`.
5. That's your `TRANSLOC_API_KEY`.

These tracker endpoints are undocumented and could change; see [samples/README.md](../samples/README.md) for what each one returns. Be polite: the server only asks TransLoc every 5 seconds, and only while someone has the app open. Please don't lower that.

### 4b. Google keys (required; needs a billing account)

> **Cost:** Google Maps Platform asks for a card, but personal use fits in Google's free monthly amounts (around 10,000 map loads, searches and route lookups each, per month). New accounts often get a free trial credit too. The server also limits itself (see `CAPS` in `server/google.js`). **You are responsible for your own keys and any bill**, so do step 9.

1. Go to https://console.cloud.google.com and sign in.
2. Top bar → project picker → **New project**. Name it anything (e.g. "hoomaps-dev") → **Create**, then make sure it's selected.
3. Left menu → **Billing** → link a billing account (follow Google's steps).
4. Left menu → **APIs & Services → Library**. Search for and **Enable** each of these:
   - **Maps JavaScript API**
   - **Places API (New)** (not the old "Places API")
   - **Routes API**
5. **Map key (for the website):** APIs & Services → **Credentials** → **Create credentials → API key**. Then click the new key to edit it:
   - Name: "HooMaps web key".
   - **Application restrictions:** Websites → add `http://localhost:5173/*`.
   - **API restrictions:** Restrict key → tick only **Maps JavaScript API**.
   - **Save.** This is your `VITE_GOOGLE_MAPS_KEY`.
6. **Server key (for search and trips):** Create credentials → API key again, then edit it:
   - Name: "HooMaps server key".
   - **Application restrictions:** None (it only ever lives on your computer or server, never in the website).
   - **API restrictions:** tick **Places API (New)** and **Routes API**.
   - **Save.** This is your `GOOGLE_SERVER_KEY`.
7. *(Optional)* **Map ID** for the custom look: left menu → **Google Maps Platform → Map management → Create Map ID** (type JavaScript, Vector). Copy the ID into `VITE_GOOGLE_MAP_ID`. Leave it blank to use Google's plain demo map; everything still works.
8. Wait a few minutes: new keys can take up to ~5 min to start working.
9. **Set a budget alert:** left menu → **Billing → Budgets & alerts → Create budget**, e.g. $5 with email alerts. Do this before you share your copy with anyone.

> Why two keys? The map key gets sent to every browser that opens the site (that's how Google maps work), so it's locked to your website's address and to drawing maps only. The server key can do searches and trip lookups, which cost more, so it never leaves the server. **Never give the server key a name starting with `VITE_`**: anything starting with `VITE_` is copied into the website for everyone to see.

---

## 5. Fill in `.env`

Open `.env` in your editor and paste your keys after the `=` signs, no quotes or spaces:

```ini
TRANSLOC_API_KEY=abc123...
VITE_GOOGLE_MAPS_KEY=AIza...
VITE_GOOGLE_MAP_ID=
GOOGLE_SERVER_KEY=AIza...
```

Leave the other lines blank for now (see step 7). **Save the file** (Ctrl+S / Cmd+S). Changes to `.env` only take effect after you restart `npm run dev`.

---

## 6. Start the app

```bash
npm run dev
```

Then open **http://localhost:5173** in your browser. You should see the map of Grounds with buses moving (if buses are running right now).

- **No buses running** (late night, breaks)? No recording is included in the repo, so first record one while buses run (`npm run record -- 30`), restart `npm run dev`, then open http://localhost:5173/?demo to replay it. An orange "Demo" badge appears.
- **See it like a phone:** press F12, then click the phone/tablet icon at the top left of the developer tools and pick an iPhone.
- **Stop the app:** click in the terminal and press **Ctrl+C**.
- While `npm run dev` runs, saving a file in `src/` updates the page instantly, and saving a file in `server/` restarts the server by itself.

Other commands:

| Command | What it does |
|---|---|
| `npm run build` then `npm run preview` | Runs the real "finished" app at the same address. Needed to test offline mode, installing, and push reminders (these only work in the built app). |
| `npm run record -- 30` | Records 30 minutes of live buses into `demo/recording.json` (what `?demo` replays). `npm run record -- 5 test` saves to `demo/recording-test.json` instead. |
| `npm run places -- <id>` | Looks up the location of a place in `server/places.json` (uses your server key). |
| `npm run icons` / `npm run cav` / `npm run qr` | Redraws the app icons / replaces the Cavman faces in Cav mode with original bus-face art / QR codes, from the scripts in `scripts/`. |

---

## 7. Optional extras: database, admin page, reminders

Everything below is optional. Without it, the app keeps working; reports and usage counts are just kept in memory (lost on restart) and reminders are off.

### Supabase (free database)

Stores rider reports, "still there?" votes, Google usage counts and reminder sign-ups.

1. Create a free account at https://supabase.com → **New project** (any name, any password, pick a US East region).
2. When it's ready: left menu → **SQL Editor** → paste the whole of [supabase/schema.sql](../supabase/schema.sql) → **Run**. (Safe to run again later.)
3. **Project Settings → API Keys**: copy the **Project URL** into `SUPABASE_URL` and a **secret key** (`sb_secret_…`) into `SUPABASE_SECRET_KEY`.
4. Restart `npm run dev`. Check http://localhost:5173/api/usage: `database.state` should say `ok`.

The secret key bypasses all database protections, so it stays in `.env` only. Phones never talk to Supabase; only the server does.

Note: free Supabase projects pause after a week with no activity. The server touches the database every 6 hours to prevent that, but if it ever pauses, click **Restore** in the Supabase dashboard.

### Admin page

Set `ADMIN_PASSWORD` to something 8+ characters long, restart, and open http://localhost:5173/admin to see and remove rider reports. Five wrong passwords lock that address out for 15 minutes.

### Leave-now reminders (push notifications)

1. Run `npx web-push generate-vapid-keys` and paste the two keys into `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`.
2. Reminders only work in the built app: `npm run build` then `npm run preview`.
3. In the app: open **My classes** → add a class → **🔔 Reminders** → turn on → **Send a test notification**.
4. On an iPhone, reminders only work when the app is added to the Home Screen and opened from there, and the site must be on HTTPS (so test on a hosted copy, step 9).

---

## 8. Editing the code: where things live

The app is plain JavaScript, HTML and CSS: no React or other framework. Every file has comments explaining what it does.

### Website (`src/`)

| File | What's in it |
|---|---|
| `main.js` | **Start here.** Loads the map, draws buses, route lines and stops, the route filter |
| `search.js` | The search card and trip options (bus vs walk vs CAT, arrive-by, "Prefer") |
| `autocomplete.js` | The type-ahead suggestions under search boxes |
| `favorites.js` | The bottom panel: today's classes, saved stops and places |
| `classes.js` / `ics.js` | My classes, leave-by times / reading the SIS calendar file |
| `reports.js` | Rider report buttons and "Still there?" |
| `eta.js` | Share my ETA |
| `notify.js` | Turning reminders on and off |
| `locate.js` | The blue "you are here" dot |
| `theme.js` | Light/dark mode and Cav mode |
| `style.css` | All styling. **Colors are variables at the top** (light set, then dark set): change them there |

`index.html` is the page itself; `public/` has the icons, app manifest and service worker (`sw.js`: offline page and notifications).

### Server (`server/`)

| File | What's in it |
|---|---|
| `index.js` | **Start here.** Every `/api/...` address the website calls, plus bus polling |
| `transloc.js` | Fetching from UVA's tracker |
| `trips.js` | Trip planning: nearest stops, which bus, ride times, transfers |
| `google.js` | All Google calls, with daily/monthly caps (`CAPS`) and caching |
| `places.json` | UVA places and nicknames |
| `reports.js`, `admin.js` | Rider reports and the admin page |
| `bunching.js`, `parked.js` | Bunched-bus and parked-bus alerts |
| `shares.js` | Share my ETA links |
| `push.js`, `reminders.js` | Notifications and class reminders |
| `db.js` | Talking to Supabase |
| `demo.js` | Replaying the demo recording |

### Common edits

- **Add a nickname:** in `server/places.json`, add it to that place's `aliases` list. Saved = live (the dev server restarts itself).
- **Add a building:** add an entry with `id`, `name`, `query` (the name plus street address works best) and `aliases`, without `location`. Run `npm run places -- <id>` and **open the map link it prints** to check the pin is on the right building (similar names get mixed up).
- **Change colors:** edit the variables at the top of `src/style.css`. Check light and dark mode (☀/🌙 button, top right).
- **Change a Google limit:** `CAPS` in `server/google.js`. Keep monthly caps under Google's free amounts.
- **Change how often buses update:** `VEHICLE_POLL_MS` in `server/index.js`. Please don't go below 5 seconds.

### Using an AI coding assistant

This project was built with Claude Code. `CLAUDE.md` has the house rules, a map of the code and known gotchas. If you use an AI assistant, have it read `CLAUDE.md` first. It's useful for humans too.

### Saving and sharing your changes

```bash
git checkout -b my-change      # make a branch for your change
git add -A
git commit -m "Describe what you changed"
```

To suggest your change for the real HooMaps, fork the repo on GitHub, push your branch there and open a pull request. See [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## 9. Host your own copy online

You need this to use your copy on a phone (location, installing to the Home Screen and notifications all need a real `https://` address). [Render](https://render.com)'s free tier works.

1. Fork the repo on GitHub (your own copy).
2. In your fork, open `render.yaml` and change `name: hoomaps` to your own name (e.g. `hoomaps-yourname`). That becomes your address: `https://hoomaps-yourname.onrender.com` (Render adds letters if it's taken).
3. Sign in to Render with GitHub → **New → Blueprint** → pick your fork → it reads `render.yaml`.
4. Fill in the settings it asks for (same values as your `.env`), then **Deploy**. After it's created, go to your service → **Environment** and add the ones `render.yaml` doesn't list: `GOOGLE_SERVER_KEY`, and if you use them `ADMIN_PASSWORD`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`. Choose **Save, rebuild, and deploy**.
5. In Google Cloud → Credentials → your **web key** → Websites: add `https://<your-address>.onrender.com/*`.
6. Every push to your fork's `main` branch redeploys automatically (~3 minutes).

Good to know:

- Settings that start with `VITE_` are baked in when the site is built. After changing one on Render, always choose **Save, rebuild, and deploy**.
- Free Render services **sleep after 15 minutes** without visitors and take ~50 seconds to wake. A free pinger such as [cron-job.org](https://cron-job.org) visiting `https://<your-address>.onrender.com/api/health` every 10 minutes keeps it awake (only during daytime hours, to stay inside Render's 750 free hours a month).
- Anyone with your link uses **your** Google keys. Keep the caps and the budget alert.

---

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| Terminal says `Missing TRANSLOC_API_KEY` and stops | The server won't start without it: step 4a. Check `.env` is saved and named exactly `.env` (not `.env.txt`). |
| "Missing Google Maps key" on the page | `VITE_GOOGLE_MAPS_KEY` is empty or `.env` wasn't saved. Restart `npm run dev` after saving. |
| Map flashes, then "Sorry! Something went wrong" | Check the browser console (F12 → Console). `RefererNotAllowedMapError` = add your address to the web key's Websites list. `InvalidKeyMapError` = wrong key, or the key and Map ID got swapped. `ApiNotActivatedMapError` = enable Maps JavaScript API. |
| Map works but search/trips don't | `GOOGLE_SERVER_KEY` missing, or Places API (New) / Routes API not enabled on it. The terminal shows the error. |
| No buses | Buses may not be running right now: try `?demo`. If they're running on uva.transloc.com but not here, TransLoc may have changed its endpoints or key: redo step 4a. |
| `Port 5173 is already in use` | Another copy is still running. Close its terminal or press Ctrl+C there. The port is fixed on purpose because the map key only allows `localhost:5173`. |
| "CAT times are resting for today" | You hit one of the app's own daily Google caps (`/api/usage` shows them). Wait until tomorrow or raise `CAPS` carefully. |
| Changes don't show up | Hard refresh (Ctrl+Shift+R). On phones, fully close and reopen the app after a deploy. |
| Notifications don't arrive | They need the built app (`npm run preview` or a hosted copy), push keys in `.env`, and on iPhone the Home Screen app over HTTPS. |
| Something else | Check the terminal running `npm run dev` and the browser console (F12) for red errors, then open an issue with what you did and the error text. Never paste your keys into an issue. |
