// "My classes": your weekly class schedule, for the "My day" plan.
// Kept on this device (browser storage), like favorites. Only if you turn on 🔔 Reminders
// is a copy (days, times, buildings) sent to our server, which buzzes you when to leave (notify.js).
// The home panel (favorites.js) shows today's classes. Tap one for an "Arrive by" trip
// (3 min before class) from your previous class's building, or from where you are for the
// next class. The next class also shows "Leave by 1:42 PM · Gold Line" in the panel.

import { openReminders, initReminders, syncPlan, leaveFrom } from './notify.js';
import { attachAutocomplete } from './autocomplete.js';
import { liveLocation } from './locate.js';
import { parseIcs } from './ics.js';

const STORE_KEY = 'hoos-riding.classes';
const MAX_CLASSES = 20;
export const DAYS = [
  { key: 'mo', short: 'Mo', long: 'Monday' },
  { key: 'tu', short: 'Tu', long: 'Tuesday' },
  { key: 'we', short: 'We', long: 'Wednesday' },
  { key: 'th', short: 'Th', long: 'Thursday' },
  { key: 'fr', short: 'Fr', long: 'Friday' },
];
const DAY_BY_JS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa']; // Date.getDay() → our key
const EARLY_MS = 3 * 60_000; // aim to arrive 3 min before class
const LEAVE_BY_WITHIN_MS = 3 * 3600_000; // only work out "leave by" for a class starting within 3 h
const LEAVE_BY_REFRESH_MS = 5 * 60_000; // (each new lookup can cost Google calls)
const SAME_BUILDING_M = 120;

// [{ id, name, days: ['mo','we'], start: '09:30', end: '10:45', place: { id, name, address, location },
//    from?, until?: 'YYYY-MM-DD' (term dates, from the SIS import), skip?: ['YYYY-MM-DD'] (break days) }]
let classes = load();
let ctx = { onChange: () => {} }; // from favorites.js: onChange, demo, openTripTo, optionName
const onChange = () => ctx.onChange();

export function initClasses(context) {
  ctx = context;
  initReminders(() => classes);
  // Redraw once a minute so "next class", faded past classes and "in X min" stay current.
  setInterval(() => {
    if (!document.hidden && classesOn().length) onChange();
  }, 60_000);
}

export const hasClasses = () => classes.length > 0;
export const allClasses = () => [...classes].sort(byDaysThenTime);

/** Today's classes, earliest first (skipping classes outside their term dates and break days). */
export function classesOn(date = new Date()) {
  const key = DAY_BY_JS[date.getDay()];
  const iso = isoDate(date);
  return classes
    .filter((c) => c.days.includes(key) && meetsOn(c, iso))
    .sort((a, b) => a.start.localeCompare(b.start));
}

const meetsOn = (c, iso) => (!c.from || iso >= c.from) && (!c.until || iso <= c.until) && !(c.skip || []).includes(iso);
const pad2 = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export function removeClass(id) {
  classes = classes.filter((c) => c.id !== id);
  changed();
}

function changed() {
  save();
  onChange();
  syncPlan({ soon: true }); // reminders on: the server gets the new list
}

// ---------- Panel rows (used by favorites.js) ----------

/** The "Today's classes" block for the home panel. */
export function classesSection({ editing }) {
  const box = document.createElement('div');
  box.className = 'classes-section';

  const today = new Date();
  const list = editing ? allClasses() : classesOn(today);
  const nowHHMM = hhmm(today);
  const upcoming = list.find((c) => c.start > nowHHMM); // the next class that hasn't started

  if (!list.length) {
    const none = document.createElement('p');
    none.className = 'card-note';
    none.textContent = classes.length ? 'No classes today.' : 'Add your classes to get a trip to each one.';
    box.append(none);
  }

  for (const c of list) {
    const row = document.createElement('div');
    row.className = 'class-row';
    const past = !editing && (c.end || c.start) <= nowHHMM;
    row.classList.toggle('past', past);
    row.classList.toggle('next', !editing && c === upcoming);

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'class-main';
    const time = document.createElement('span');
    time.className = 'class-time';
    time.textContent = editing ? `${dayLabel(c.days)} ${clock(c.start)}` : clock(c.start);
    const text = document.createElement('span');
    text.className = 'class-text';
    const name = document.createElement('span');
    name.className = 'class-name';
    name.textContent = c.name;
    const where = document.createElement('span');
    where.className = 'class-where';
    where.textContent = c.place.name;
    text.append(name, where);
    main.append(time, text);
    if (editing) {
      main.setAttribute('aria-label', `Edit ${c.name}, ${dayLabel(c.days)} at ${clock(c.start)}, ${c.place.name}`);
      main.addEventListener('click', () => openClassForm(c));
    } else {
      main.setAttribute('aria-label', `${c.name} at ${clock(c.start)}, ${c.place.name}. Trip there.`);
      main.addEventListener('click', () => openClassTrip(c, list));
    }
    row.append(main);
    if (!editing && c === upcoming) {
      const leave = leaveByLine(c, list);
      if (leave) text.append(leave);
    }

    if (editing) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'fav-remove';
      remove.textContent = '✕';
      remove.setAttribute('aria-label', `Remove ${c.name}`);
      remove.addEventListener('click', () => removeClass(c.id));
      row.append(remove);
    }
    box.append(row);
  }

  const actions = document.createElement('div');
  actions.className = 'class-panel-actions';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'link-button add-class';
  add.textContent = '＋ Add class';
  add.addEventListener('click', () => openClassForm(null));
  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'link-button add-class';
  importBtn.textContent = '📥 Import from SIS';
  importBtn.addEventListener('click', openImport);
  const remind = document.createElement('button');
  remind.type = 'button';
  remind.className = 'link-button add-class';
  remind.textContent = '🔔 Reminders';
  remind.addEventListener('click', openReminders);
  actions.append(add, importBtn, remind);
  box.append(actions);
  return box;
}

// ---------- Getting there ----------

/** Today at "HH:MM" as clock ms. */
function todayAt(value) {
  const [h, m] = value.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

const startsAt = (c) => todayAt(c.start);
const endsAt = (c) => todayAt(c.end || c.start);

// The class right before this one today (where you'll be coming from).
const previousClass = (c, list) => [...list].reverse().find((p) => p.start < c.start) || null;

function metersBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(h));
}

// Tap a class: "Arrive by" 3 min early. The next class starts from where you are; a later
// class starts from the class before it. A class that already started: Leave now.
function openClassTrip(c, list) {
  const nowMs = Date.now();
  const target = startsAt(c) - EARLY_MS;
  const prev = previousClass(c, list);
  const isNext = c === list.find((x) => startsAt(x) > nowMs);
  const from = !isNext && prev ? { name: `${prev.place.name} (after ${prev.name})`, location: prev.place.location } : null;
  ctx.openTripTo(c.place, { arriveBy: target > nowMs ? target : null, from });
}

/**
 * Tapped a leave-now reminder: open that class's trip from the same start as the reminder
 * (the previous class's building today, else "usually leave from", else your location),
 * and show the best option on the map. Returns false if the class isn't on this phone.
 */
export function openReminderTrip(classId) {
  const today = classesOn();
  const c = today.find((x) => x.id === classId) || classes.find((x) => x.id === classId);
  if (!c) return false;
  const prev = previousClass(c, today);
  const home = leaveFrom();
  const from = prev
    ? { name: `${prev.place.name} (after ${prev.name})`, location: prev.place.location }
    : home?.location ? { name: home.name, location: home.location } : null;
  const target = startsAt(c) - EARLY_MS;
  ctx.openTripTo(c.place, { arriveBy: target > Date.now() + 60_000 ? target : null, from, pickBest: true });
  return true;
}

// "Leave by 1:42 PM · Gold Line" under the next class. Cached so panel redraws don't refetch.
let leaveCache = { key: '', at: 0, answer: null, loading: false }; // answer: see summarize()

function leaveByLine(c, list) {
  const nowMs = Date.now();
  const target = startsAt(c) - EARLY_MS;
  const el = document.createElement('span');
  el.className = 'class-leave';
  if (target - nowMs > LEAVE_BY_WITHIN_MS) return null;
  if (target <= nowMs) {
    if (startsAt(c) > nowMs) el.textContent = '⏰ Starts soon: leave now!';
    else return null; // already started
    return el;
  }

  // Start from where you are (blue dot, or a quiet check if location is already allowed:
  // never a surprise prompt),
  // else from the previous class's building if it's over.
  const prev = previousClass(c, list);
  const live = liveLocation() || quietPosition();
  const fromPoint = live || (prev && endsAt(prev) <= nowMs + 60_000 ? prev.place.location : null);
  if (!fromPoint) {
    el.textContent = 'Tap for your leave-by time';
    return el;
  }
  if (metersBetween(fromPoint, c.place.location) < SAME_BUILDING_M) {
    el.textContent = live ? '📍 You’re already there' : '📍 Same building as your last class';
    return el;
  }

  // Rounded to ~100 m so small moves reuse the same saved answer (fewer Google calls).
  const r = (n) => n.toFixed(3);
  const key = `${c.id}|${r(fromPoint.lat)},${r(fromPoint.lng)}|${target}`;
  if (leaveCache.key === key && leaveCache.answer) el.textContent = leaveText(leaveCache.answer);
  else el.textContent = 'Working out when to leave…';
  const stale = leaveCache.key !== key || nowMs - leaveCache.at > LEAVE_BY_REFRESH_MS;
  if (stale && !leaveCache.loading && !document.hidden) fetchLeaveBy(key, fromPoint, c.place.location, target);
  return el;
}

// Your position without the blue dot, ONLY if you already allowed location for this site
// (no surprise prompt). Checked at most once every 5 min; stays on the phone.
const QUIET_EVERY_MS = 5 * 60_000;
let quiet = { at: 0, position: null, asking: false };

function quietPosition() {
  const fresh = Date.now() - quiet.at < QUIET_EVERY_MS;
  if (!fresh && !quiet.asking && navigator.geolocation && navigator.permissions?.query) {
    quiet.asking = true;
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((status) => {
        if (status.state !== 'granted') return null;
        return new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            () => resolve(null),
            { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
          );
        });
      })
      .catch(() => null)
      .then((position) => {
        const changed = Boolean(position) !== Boolean(quiet.position);
        quiet = { at: Date.now(), position, asking: false };
        if (position || changed) onChange(); // redraw with the new starting point
      });
  }
  return quiet.position;
}

async function fetchLeaveBy(key, from, to, target) {
  leaveCache = { ...leaveCache, loading: true };
  const pt = (p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  let answer;
  try {
    const res = await fetch(`/api/trip?from=${pt(from)}&to=${pt(to)}&arriveBy=${target}${ctx.demo ? '&demo=1' : ''}`);
    const trip = await res.json();
    if (!res.ok) throw new Error(trip.error || `status ${res.status}`);
    answer = summarize(trip);
  } catch (err) {
    console.error('Leave-by time', err);
    answer = { failed: true };
  }
  leaveCache = { key, at: Date.now(), answer, loading: false };
  onChange(); // redraw the panel with the answer
}

// Keep just what the panel needs: { tooLate } | { failed } | { leaveAtMs, how }
function summarize(trip) {
  if (trip.tooLate) return { tooLate: true };
  const top = trip.options?.[0];
  if (!top) return { failed: true };
  const how = top.type === 'walk' ? '🚶 walk' : `🚌 ${ctx.optionName(top).replace(/^the /, '')}`;
  return { leaveAtMs: Date.now() + top.leaveBySeconds * 1000, how };
}

function leaveText(a) {
  if (a.failed) return 'Tap for trip options';
  const secs = (a.leaveAtMs - Date.now()) / 1000;
  if (a.tooLate || secs < -60) return '⏰ Leave now! Even walking is tight';
  if (secs <= 60) return `⏰ Leave now · ${a.how}`;
  const minsAway = Math.round(secs / 60);
  return `⏰ Leave by ${clock(hhmm(new Date(a.leaveAtMs)))}${minsAway <= 30 ? ` (in ${minsAway} min)` : ''} · ${a.how}`;
}

// ---------- Add / edit form ----------

let dialog = null;

function openClassForm(existing) {
  if (!existing && classes.length >= MAX_CLASSES) {
    alert(`You can save up to ${MAX_CLASSES} classes. Remove one first.`);
    return;
  }
  dialog?.remove();
  dialog = document.createElement('dialog');
  dialog.className = 'class-dialog';
  dialog.setAttribute('aria-label', existing ? 'Edit class' : 'Add class');

  const form = document.createElement('form');
  form.method = 'dialog';
  const title = document.createElement('h2');
  title.textContent = existing ? 'Edit class' : 'Add class';

  // Name
  const nameInput = field('text', 'Class', existing?.name || '', 'e.g. CS 2100');
  nameInput.input.maxLength = 40;

  // Building (same search as the main box: nicknames, buildings, bus stops)
  let place = existing?.place || null;
  const placeWrap = document.createElement('label');
  placeWrap.className = 'class-field';
  placeWrap.textContent = 'Building';
  const placeInput = document.createElement('input');
  placeInput.type = 'search';
  placeInput.className = 'start-input';
  placeInput.placeholder = 'e.g. Rice Hall';
  placeInput.autocomplete = 'off';
  placeInput.spellcheck = false;
  placeInput.value = place?.name || '';
  const placeList = document.createElement('ul');
  placeList.id = 'class-place-suggestions';
  placeList.className = 'suggestions inline';
  placeList.setAttribute('role', 'listbox');
  placeList.setAttribute('aria-label', 'Building suggestions');
  placeList.hidden = true;
  placeWrap.append(placeInput);
  attachAutocomplete({
    input: placeInput,
    listEl: placeList,
    onPick: (p) => {
      place = { id: p.id, name: p.name, address: p.address || '', location: p.location };
      placeInput.value = p.name;
      error.textContent = '';
    },
    onError: (msg) => {
      error.textContent = msg;
    },
  });
  placeInput.addEventListener('input', () => {
    if (place && placeInput.value !== place.name) place = null; // typed something new: pick again
  });

  // Days
  const days = new Set(existing?.days || []);
  const dayRow = document.createElement('div');
  dayRow.className = 'class-days';
  dayRow.setAttribute('role', 'group');
  dayRow.setAttribute('aria-label', 'Days');
  for (const d of DAYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-button';
    b.textContent = d.short;
    b.setAttribute('aria-label', d.long);
    b.setAttribute('aria-pressed', String(days.has(d.key)));
    b.addEventListener('click', () => {
      if (days.has(d.key)) days.delete(d.key);
      else days.add(d.key);
      b.setAttribute('aria-pressed', String(days.has(d.key)));
    });
    dayRow.append(b);
  }

  // Times
  const times = document.createElement('div');
  times.className = 'class-times';
  const start = field('time', 'Starts', existing?.start || '');
  const end = field('time', 'Ends', existing?.end || '');
  times.append(start.label, end.label);

  const error = document.createElement('p');
  error.className = 'class-error';
  error.setAttribute('role', 'alert');

  const actions = document.createElement('div');
  actions.className = 'class-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'link-button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => dialog.close());
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'star-button class-save';
  saveBtn.textContent = existing ? 'Save' : 'Add class';
  actions.append(cancel, saveBtn);

  form.append(title, nameInput.label, placeWrap, placeList, dayRow, times, error, actions);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const problem =
      !nameInput.input.value.trim() ? 'Give the class a name.' :
      !place ? 'Pick the building from the suggestions.' :
      !days.size ? 'Pick at least one day.' :
      !start.input.value ? 'Add a start time.' :
      end.input.value && end.input.value <= start.input.value ? 'The end time should be after the start.' :
      '';
    if (problem) {
      error.textContent = problem;
      return;
    }
    const entry = {
      ...existing, // keeps term dates / break days from an SIS import
      id: existing?.id || newId(),
      name: nameInput.input.value.trim(),
      days: DAYS.map((d) => d.key).filter((k) => days.has(k)),
      start: start.input.value,
      end: end.input.value || '',
      place,
    };
    classes = existing ? classes.map((c) => (c.id === existing.id ? entry : c)) : [...classes, entry];
    changed();
    dialog.close();
  });

  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  if (!existing) nameInput.input.focus();
}

function field(type, labelText, value, placeholder = '') {
  const label = document.createElement('label');
  label.className = 'class-field';
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.className = 'start-input';
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  label.append(input);
  return { label, input };
}

// ---------- Import from SIS (.ics file) ----------

function newDialog(label) {
  dialog?.remove();
  dialog = document.createElement('dialog');
  dialog.className = 'class-dialog';
  dialog.setAttribute('aria-label', label);
  const mine = dialog;
  mine.addEventListener('close', () => mine.remove());
  document.body.append(mine);
  return mine;
}

function openImport() {
  const d = newDialog('Import classes from SIS');
  const title = document.createElement('h2');
  title.textContent = '📥 Import from SIS';
  const steps = document.createElement('ol');
  steps.className = 'import-steps';
  for (const text of [
    'In SIS, open My Schedule (left menu on the Dashboard).',
    'Tap Download (.ics) at the top and pick this term.',
    'Choose that file below.',
  ]) {
    const li = document.createElement('li');
    li.textContent = text;
    steps.append(li);
  }
  const fileLabel = document.createElement('label');
  fileLabel.className = 'star-button import-file';
  const fileText = document.createElement('span');
  fileText.textContent = 'Choose the .ics file';
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.ics,text/calendar';
  file.className = 'visually-hidden';
  fileLabel.append(fileText, file);
  const error = note('', 'class-error');
  error.setAttribute('role', 'alert');
  const actions = document.createElement('div');
  actions.className = 'class-actions';
  actions.append(cancelButton());
  d.append(title, steps, fileLabel, note('The file is read on this phone, and your classes are saved only here.'), error, actions);
  d.showModal();

  file.addEventListener('change', async () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    error.textContent = '';
    fileText.textContent = 'Reading…';
    try {
      if (chosen.size > 1_000_000) throw new Error('That file is too big to be a class schedule.');
      const parsed = parseIcs(await chosen.text());
      if (!parsed.classes.length) throw new Error('No weekly classes found in that file. Is it the .ics from SIS My Schedule?');
      const matches = await matchBuildings(parsed.classes);
      showImportPreview(parsed, matches);
    } catch (err) {
      console.error('Import', err);
      error.textContent = err.message || 'Could not read that file.';
      fileText.textContent = 'Choose the .ics file';
      file.value = '';
    }
  });
}

// Building names → our UVA places (free: our own list, no Google). Unknown ones stay null.
async function matchBuildings(list) {
  const names = [...new Set(list.flatMap((c) => c.buildings || [c.building]).filter(Boolean))];
  if (!names.length) return {};
  try {
    const res = await fetch(`/api/buildings?names=${encodeURIComponent(names.join('|'))}`);
    return (await res.json()).matches || {};
  } catch {
    return {}; // you can still pick each building by hand
  }
}

function showImportPreview({ classes: found, skipped }, matches) {
  const d = newDialog('Classes found');
  const today = isoDate(new Date());
  const title = document.createElement('h2');
  title.textContent = `${found.length} class${found.length === 1 ? '' : 'es'} found`;
  d.append(title);

  const ended = found.every((c) => c.until && c.until < today);
  if (ended) d.append(note(`This schedule ended on ${shortDate(found[0].until)}. In SIS, pick the current term.`, 'class-error'));

  const rows = found.map((c, i) => {
    const row = document.createElement('div');
    row.className = 'import-row';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = !(c.until && c.until < today);
    check.id = `import-${i}`;
    const label = document.createElement('label');
    label.htmlFor = check.id;
    label.className = 'import-label';
    const name = document.createElement('span');
    name.className = 'class-name';
    name.textContent = `${c.name} · ${dayLabel(c.days)} ${clock(c.start)}${c.end ? `–${clock(c.end)}` : ''}`;
    const sub = document.createElement('span');
    sub.className = 'class-where';
    const dates = c.from > today ? `starts ${shortDate(c.from)}`
      : c.until && c.until < today ? `ended ${shortDate(c.until)}`
        : c.until ? `until ${shortDate(c.until)}` : '';
    sub.textContent = [c.title, dates].filter(Boolean).join(' · ');
    label.append(name, sub);
    const top = document.createElement('div');
    top.className = 'import-top';
    top.append(check, label);
    row.append(top);

    // Building: matched for free from our list, or pick it with the search box.
    const known = (c.buildings || [c.building]).map((b) => b && matches[b]).find(Boolean) || null;
    const entry = { c, check, place: known };
    const where = document.createElement('div');
    where.className = 'import-where';
    if (known) {
      where.textContent = `📍 ${known.name}${c.rooms.length ? ` (${c.rooms.join(' / ')})` : ''}`;
    } else {
      const ask = document.createElement('span');
      ask.textContent = c.building ? `Which building is "${c.rooms.join(' / ')}"?` : 'No room listed in SIS. Pick the building:';
      const input = document.createElement('input');
      input.type = 'search';
      input.className = 'start-input';
      input.placeholder = 'e.g. Rice Hall';
      input.autocomplete = 'off';
      input.spellcheck = false;
      if (c.building) input.value = c.building;
      const list = document.createElement('ul');
      list.id = `import-place-${i}`;
      list.className = 'suggestions inline';
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', `Building for ${c.name}`);
      list.hidden = true;
      attachAutocomplete({
        input,
        listEl: list,
        onPick: (p) => {
          entry.place = { id: p.id, name: p.name, address: p.address || '', location: p.location };
          input.value = p.name;
        },
        onError: (msg) => (input.placeholder = msg),
      });
      input.addEventListener('input', () => {
        if (entry.place && input.value !== entry.place.name) entry.place = null;
      });
      where.append(ask, input, list);
    }
    row.append(where);
    d.append(row);
    return entry;
  });

  if (skipped.length) d.append(note(`Skipped: ${skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}.`));

  let replace = null;
  if (classes.length) {
    const wrap = document.createElement('label');
    wrap.className = 'import-replace';
    replace = document.createElement('input');
    replace.type = 'checkbox';
    replace.checked = true;
    wrap.append(replace, ` Replace my ${classes.length} current class${classes.length === 1 ? '' : 'es'}`);
    d.append(wrap);
  }

  const error = note('', 'class-error');
  error.setAttribute('role', 'alert');
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'star-button class-save';
  go.textContent = 'Import';
  go.addEventListener('click', () => {
    const chosen = rows.filter((r) => r.check.checked);
    if (!chosen.length) return void (error.textContent = 'Tick at least one class.');
    const missing = chosen.find((r) => !r.place);
    if (missing) return void (error.textContent = `Pick the building for ${missing.c.name} from the suggestions.`);
    const keep = replace?.checked ? [] : classes;
    if (keep.length + chosen.length > MAX_CLASSES) return void (error.textContent = `That's more than ${MAX_CLASSES} classes. Untick some.`);
    const added = chosen.map(({ c, place }) => ({
      id: newId(),
      name: c.name,
      title: c.title,
      days: c.days,
      start: c.start,
      end: c.end,
      place,
      from: c.from,
      until: c.until,
      skip: c.skip,
    }));
    classes = [...keep, ...added];
    changed();
    d.close();
  });
  const actions = document.createElement('div');
  actions.className = 'class-actions';
  actions.append(cancelButton(), go);
  d.append(error, actions);
  d.showModal();
}

function cancelButton() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'link-button';
  b.textContent = 'Cancel';
  b.addEventListener('click', () => dialog?.close());
  return b;
}

function note(text, className = 'card-note') {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}

/** '2026-12-08' → "Dec 8" */
function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ---------- Helpers ----------

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** "09:30" → "9:30 AM" */
export function clock(value) {
  const [h, m] = value.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** ['mo','we'] → "MoWe" (like SIS) */
export const dayLabel = (days) => days.map((k) => DAYS.find((d) => d.key === k)?.short || '').join('');

function byDaysThenTime(a, b) {
  const first = (c) => Math.min(...c.days.map((k) => DAYS.findIndex((d) => d.key === k)));
  return first(a) - first(b) || a.start.localeCompare(b.start);
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `c${Date.now()}${Math.random()}`);

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORE_KEY));
    return Array.isArray(data) ? data.filter((c) => c?.place?.location && Array.isArray(c.days)) : [];
  } catch {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(classes));
  } catch {
    // Private browsing can block storage: classes still work until the app closes.
  }
}
