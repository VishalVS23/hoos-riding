// iPhones never offer to install web apps on their own, so we show a small tip
// explaining how. Only on iPhone/iPad, only in the browser (not once installed),
// and never again after it's dismissed.

const DISMISSED_KEY = 'hoos-riding.install-tip-dismissed';

export function showInstallTipIfNeeded() {
  const isIOS =
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPads report as Mac
  const isInstalled =
    navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

  if (!isIOS || isInstalled || wasDismissed()) return;

  const tip = document.createElement('aside');
  tip.className = 'install-tip';
  tip.setAttribute('aria-label', 'Install tip');
  tip.innerHTML = `
    <img src="/icons/icon-192.png" alt="" width="40" height="40" />
    <p>
      <strong>Add HooMaps to your Home Screen</strong><br />
      Tap <span class="share-icon" aria-label="the Share button">${SHARE_ICON}</span>
      then <strong>Add to Home Screen</strong>.
    </p>
    <button type="button" aria-label="Dismiss install tip">✕</button>
  `;
  tip.querySelector('button').addEventListener('click', () => {
    tip.remove();
    document.body.classList.remove('has-install-tip');
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Storage blocked (private browsing): the tip just shows again next visit.
    }
  });

  document.body.append(tip);
  document.body.classList.add('has-install-tip');
}

function wasDismissed() {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

// The iOS Share icon: a box with an arrow pointing up.
const SHARE_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>`;
