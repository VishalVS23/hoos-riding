# Contributing to HooMaps

Thanks for helping! This is a student project run by one person, so small, focused changes are easiest to review.

## Easiest ways to help (no code)

Open an [issue](../../issues) for:

- **A bug:** what you did, what you expected, what happened, your phone + browser, and the time (bus data changes by the minute). A screenshot helps.
- **A missing place or nickname** (e.g. "nobody calls it X, everyone says Y"): include the building's real name.
- **An idea** for a feature.

## Changing code

1. Fork the repo and make a branch.
2. Set it up on your computer with the step-by-step [setup guide](docs/SETUP.md). You'll need your own Google keys; never commit them (`.env` is ignored by git).
3. Keep it simple: plain JavaScript, no new frameworks. Add a new package only if there's a good reason, and say why in the pull request.
4. Test on a phone-sized screen, in light and dark mode. If your change touches trips, try `?demo` too (record your own first: `npm run record`).
5. Open a pull request saying **what** changed and **how you tested it**.

### Adding a place or nickname

Edit `server/places.json`:

- **Nickname for an existing place:** add it to that place's `aliases` list.
- **New place:** add an entry with `id`, `name`, `query` (the name plus street address works best) and `aliases`, but no `location`. Then run `npm run places -- <id>` (uses your Google server key) and open the map link it prints to check the pin is on the right building.

## Ground rules

- Be kind. Reports of bad behavior go to the maintainer through GitHub.
- Never add anything that shows or stores individual riders' locations.
- Don't add code that calls TransLoc or Google from the phone; it all goes through the server, with caps and caching.
- Only the maintainer merges into `main`, and every merge deploys the live site.
