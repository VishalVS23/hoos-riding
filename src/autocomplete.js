// Reusable "type a place, get suggestions" behavior.
// Used by the main search bar and by the "Starting from" box in the trip card.
// All searching goes through our server (/api/search, /api/places/:id),
// which checks our UVA nickname list before spending any Google calls.

const TYPE_PAUSE_MS = 250; // wait until typing pauses before searching

// Google bills "type letters, then pick a place" as ONE search when every request
// shares the same session token. Each box starts a fresh token after each pick.
const newSession = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

let boxCount = 0;

// Demo mode (?demo) searches the recording's bus stops.
const demoFlag = () => (new URLSearchParams(location.search).has('demo') ? '&demo=1' : '');

/**
 * input:  the <input> to watch
 * listEl: the <ul> to fill with suggestions
 * onPick(place): called with { id, name, address, location, source } once a place is chosen
 * onError(message): called if looking up the chosen place fails
 * Returns { clear(), close() }.
 */
export function attachAutocomplete({ input, listEl, onPick, onError }) {
  const prefix = `ac${++boxCount}`;
  let suggestions = [];
  let highlighted = -1;
  let typingTimer = null;
  let searchCount = 0; // ignore answers to old searches that arrive late
  let session = newSession();

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', listEl.id);

  input.addEventListener('input', () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => runSearch(input.value), TYPE_PAUSE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggestions.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      highlighted = (highlighted + step + suggestions.length) % suggestions.length;
      draw();
    } else if (e.key === 'Escape') {
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const choice = suggestions[Math.max(0, highlighted)];
      if (choice) pick(choice);
    }
  });

  input.addEventListener('focus', () => {
    if (suggestions.length) open();
  });

  async function runSearch(text) {
    const query = text.trim();
    const mySearch = ++searchCount;
    if (!query) {
      suggestions = [];
      close();
      return;
    }
    let data;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&session=${session}${demoFlag()}`);
      data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
    } catch (err) {
      if (mySearch !== searchCount) return;
      console.error(err);
      message(friendly(err.message));
      return;
    }
    if (mySearch !== searchCount) return; // the user kept typing; a newer search is coming

    suggestions = data.suggestions;
    highlighted = -1;
    if (!suggestions.length) {
      message(query.length < 3 ? 'Keep typing…' : 'No places found. Try another name.');
      return;
    }
    draw();
    open();
  }

  function draw() {
    listEl.replaceChildren();
    suggestions.forEach((s, i) => {
      const li = document.createElement('li');
      li.id = `${prefix}-${i}`;
      li.className = 'suggestion';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === highlighted));

      const text = document.createElement('div');
      text.className = 'suggestion-text';
      const name = document.createElement('div');
      name.className = 'suggestion-name';
      name.textContent = s.name;
      const detail = document.createElement('div');
      detail.className = 'suggestion-detail';
      detail.textContent = s.detail;
      text.append(name, detail);
      li.append(text);

      if (s.source === 'uva' || s.source === 'stop') {
        const badge = document.createElement('span');
        badge.className = s.source === 'stop' ? 'badge-uva badge-stop' : 'badge-uva';
        badge.textContent = s.source === 'stop' ? '🚏 STOP' : 'UVA';
        li.append(badge);
      }

      // pointerdown (not click) so it fires before the input loses focus.
      li.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        pick(s);
      });
      listEl.append(li);
    });
    if (highlighted >= 0) input.setAttribute('aria-activedescendant', `${prefix}-${highlighted}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function message(text) {
    suggestions = [];
    listEl.replaceChildren();
    const li = document.createElement('li');
    li.className = 'suggestion-message';
    li.textContent = text;
    listEl.append(li);
    open();
  }

  function open() {
    listEl.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function close() {
    listEl.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  async function pick(choice) {
    close();
    input.value = choice.name;
    input.blur(); // hide the phone keyboard so the map is visible
    try {
      const res = await fetch(`/api/places/${encodeURIComponent(choice.id)}?session=${session}${demoFlag()}`);
      const place = await res.json();
      if (!res.ok) throw new Error(place.error || 'Place lookup failed');
      onPick({ ...place, name: place.name || choice.name, address: place.address || choice.detail });
    } catch (err) {
      console.error(err);
      onError?.(friendly(err.message, "Couldn't find that place. Try another search."));
    } finally {
      session = newSession(); // this search is finished; the next one is a new session
    }
  }

  return {
    close,
    clear() {
      input.value = '';
      suggestions = [];
      close();
      session = newSession();
    },
  };
}

// Show our server's friendly messages ("Search is resting for today…"), hide technical ones.
function friendly(message, fallback = 'Search is unavailable right now.') {
  return /^(Search is resting|Slow down)/.test(message) ? message : fallback;
}
