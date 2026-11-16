// Reads a calendar file (.ics) from SIS (Dashboard → My Schedule → Download (.ics)) into
// weekly classes. Runs on the phone: the file never goes to our server.
// SIS writes one VEVENT per meeting: SUMMARY = "CS 2100", DESCRIPTION = title,
// LOCATION = "Rouss Hall 410", RRULE = weekly BYDAY=MO,WE + UNTIL, EXDATE = break days.

const DAY_KEYS = { MO: 'mo', TU: 'tu', WE: 'we', TH: 'th', FR: 'fr' };
const NO_ROOM = /contact department|^tba$|to be announced|online|web.?based|asynchronous|^none$/i;

/**
 * Returns { classes: [...], skipped: [{ name, reason }] }
 * class: { name, title, days, start: 'HH:MM', end, from: 'YYYY-MM-DD', until, skip: [dates],
 *          rooms: ['Rouss Hall 410'], building: 'Rouss Hall' | null }
 */
export function parseIcs(text) {
  const events = readEvents(text);
  const classes = [];
  const skipped = [];

  for (const ev of events) {
    const name = (ev.SUMMARY || ev.DESCRIPTION || 'Class').trim();
    const start = readDateTime(ev.DTSTART);
    if (!start || !start.time) {
      skipped.push({ name, reason: 'no class time' });
      continue;
    }
    const end = readDateTime(ev.DTEND);
    const rule = Object.fromEntries((ev.RRULE || '').split(';').filter(Boolean).map((part) => part.split('=')));
    const until = rule.UNTIL ? readDateTime(rule.UNTIL)?.date : null;
    if (!ev.RRULE || rule.FREQ !== 'WEEKLY' || (until && until === start.date)) {
      skipped.push({ name, reason: `one-time session${start.date ? ` on ${prettyDate(start.date)}` : ''}` });
      continue;
    }
    const days = (rule.BYDAY || '').split(',').map((d) => DAY_KEYS[d.replace(/^[-+\d]+/, '')]).filter(Boolean);
    if (!days.length) {
      skipped.push({ name, reason: 'only meets on weekends' });
      continue;
    }

    const room = (ev.LOCATION || '').trim();
    const group = {
      name,
      title: (ev.DESCRIPTION || '').trim(),
      days: Object.values(DAY_KEYS).filter((k) => days.includes(k)),
      start: start.time,
      end: end?.time || '',
      from: start.date,
      until: until || '',
      skip: [...new Set((ev.EXDATE || []).flatMap((v) => v.split(',')).map((v) => readDateTime(v)?.date).filter(Boolean))],
      rooms: room ? [room] : [],
      building: buildingOf(room),
    };

    // Same class, same days and time, another room (e.g. a split section): one class, 2 rooms.
    const twin = classes.find((c) => c.name === group.name && c.start === group.start && c.days.join() === group.days.join());
    if (twin) {
      for (const r of group.rooms) if (!twin.rooms.includes(r)) twin.rooms.push(r);
      if (!twin.building) twin.building = group.building;
      twin.buildings = [...new Set([...(twin.buildings || [twin.building]), group.building].filter(Boolean))];
      continue;
    }
    classes.push(group);
  }

  classes.sort((a, b) => a.days[0].localeCompare(b.days[0]) || a.start.localeCompare(b.start));
  return { classes, skipped };
}

/** "Rouss Hall 410" → "Rouss Hall"; "Cobb Hall Room 370" → "Cobb Hall"; "Contact Department" → null */
export function buildingOf(room) {
  if (!room || NO_ROOM.test(room)) return null;
  let words = room.replace(/\s+(room|rm\.?)\s+\S+$/i, '').split(/\s+/);
  while (words.length > 1 && /\d/.test(words.at(-1))) words = words.slice(0, -1); // room number like 410, 317B, E316
  const name = words.join(' ').trim();
  return name || null;
}

// ---------- Reading the file ----------

// Lines → [{ SUMMARY, LOCATION, DTSTART, ..., EXDATE: [values] }] for each VEVENT.
function readEvents(text) {
  // Long lines are "folded": continued on the next line, which starts with a space or tab.
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') ev = { EXDATE: [] };
    else if (line === 'END:VEVENT') {
      if (ev) events.push(ev);
      ev = null;
    } else if (ev) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon).split(';')[0].toUpperCase();
      const value = unescapeText(line.slice(colon + 1));
      if (key === 'EXDATE') ev.EXDATE.push(value);
      else if (!(key in ev)) ev[key] = value;
    }
  }
  return events;
}

const unescapeText = (v) => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');

// "20260825T110000" → { date: '2026-08-25', time: '11:00' } (SIS writes local Eastern times).
// A time ending in Z is UTC: shown in this phone's own time zone.
function readDateTime(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/.exec(String(value || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (z) {
    const local = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
    const pad = (n) => String(n).padStart(2, '0');
    return {
      date: `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`,
      time: `${pad(local.getHours())}:${pad(local.getMinutes())}`,
    };
  }
  return { date: `${y}-${mo}-${d}`, time: h ? `${h}:${mi}` : null };
}

function prettyDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
