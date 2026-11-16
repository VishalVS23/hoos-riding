// Light / dark mode.
// Follows the phone's setting unless you tap the ☀/🌙 button, which remembers your choice
// on this device. Tapping back to whatever the phone uses goes back to following the phone.
// index.html sets the theme before anything draws (no white flash); this file adds the button.
// Google can't change a map's colors once it's drawn, so switching reloads the page.

const KEY = 'hoos-riding.theme';
const systemTheme = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

function savedTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export const currentTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

export function initThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  const dark = currentTheme() === 'dark';
  btn.textContent = dark ? '☀️' : '🌙';
  btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  btn.hidden = false;
  btn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    try {
      if (next === systemTheme()) localStorage.removeItem(KEY); // same as the phone: follow it again
      else localStorage.setItem(KEY, next);
    } catch {
      // Storage blocked (private browsing): switch for this visit only.
      document.documentElement.dataset.theme = next;
    }
    location.reload();
  });

  // The phone switched light/dark (e.g. at sunset) and you haven't picked one yourself.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!savedTheme() && systemTheme() !== currentTheme()) location.reload();
  });
}

// ---------- Cav mode (just for fun) ----------
// Buses become cartoon bus faces (original art, scripts/make-cav.js) inside a ring in the route's color (styles: body.cav in style.css).
// Facing left/right = the way the bus is driving; sleeping = stopped; angry ⏰ = delayed.
// Remembered on this device. No reload needed.

const CAV_KEY = 'hoos-riding.cav';

export function initCavToggle() {
  const btn = document.getElementById('cav-toggle');
  let on = false;
  try {
    on = localStorage.getItem(CAV_KEY) === '1';
  } catch {
    // storage blocked: starts off
  }
  const apply = () => {
    document.body.classList.toggle('cav', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'Cav mode is on (tap for normal buses)' : 'Cav mode';
  };
  apply();
  btn.hidden = false;
  btn.addEventListener('click', () => {
    on = !on;
    try {
      if (on) localStorage.setItem(CAV_KEY, '1');
      else localStorage.removeItem(CAV_KEY);
    } catch {
      // storage blocked: works for this visit only
    }
    apply();
  });
}
