// Draws the Cav mode bus faces (original art: the HooMaps orange bus with a face).
// Run with: npm run cav   (writes public/cav/*.png, 96 x 96)
//
//   front.png  looking at you (moving, heading up/down)
//   right.png  side view driving right    left.png  same, driving left
//   sleep.png  eyes closed + "z" (bus stopped)
//   late.png   grumpy + little clock (TransLoc says delayed)
//
// The app shows each picture inside a circle ringed in the route's color,
// so everything important stays inside the middle circle.

import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const NAVY = '#232d4b';
const ORANGE = '#e57200';
const ORANGE_DARK = '#b35900';
const SKY = '#dce8f5';

const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="384" height="384">
  <rect width="96" height="96" fill="#fff"/>
  ${inner}
</svg>`;

// Bus seen from the front; `face` is drawn on the windshield + grille.
function front(face) {
  return wrap(`
  <rect x="31" y="74" width="10" height="9" rx="3" fill="${NAVY}"/>
  <rect x="55" y="74" width="10" height="9" rx="3" fill="${NAVY}"/>
  <rect x="22" y="16" width="52" height="62" rx="12" fill="${ORANGE}" stroke="${NAVY}" stroke-width="3"/>
  <rect x="38" y="20" width="20" height="4" rx="2" fill="${NAVY}"/>
  <rect x="28" y="28" width="40" height="26" rx="6" fill="${SKY}" stroke="${NAVY}" stroke-width="2.5"/>
  <circle cx="31" cy="66" r="4" fill="#fff" stroke="${NAVY}" stroke-width="2"/>
  <circle cx="65" cy="66" r="4" fill="#fff" stroke="${NAVY}" stroke-width="2"/>
  ${face}`);
}

const awake = `
  <circle cx="39" cy="41" r="6.5" fill="#fff" stroke="${NAVY}" stroke-width="2"/>
  <circle cx="57" cy="41" r="6.5" fill="#fff" stroke="${NAVY}" stroke-width="2"/>
  <circle cx="40" cy="42" r="3.2" fill="${NAVY}"/>
  <circle cx="58" cy="42" r="3.2" fill="${NAVY}"/>
  <circle cx="41.2" cy="40.6" r="1.1" fill="#fff"/>
  <circle cx="59.2" cy="40.6" r="1.1" fill="#fff"/>
  <path d="M40 62 Q48 70 56 62" fill="none" stroke="${NAVY}" stroke-width="3" stroke-linecap="round"/>`;

const asleep = `
  <path d="M33 42 Q39 47 45 42" fill="none" stroke="${NAVY}" stroke-width="2.8" stroke-linecap="round"/>
  <path d="M51 42 Q57 47 63 42" fill="none" stroke="${NAVY}" stroke-width="2.8" stroke-linecap="round"/>
  <ellipse cx="48" cy="64" rx="3.5" ry="2.5" fill="${NAVY}"/>
  <g fill="${NAVY}" stroke="#fff" stroke-width="2.5" paint-order="stroke" font-family="Arial, Helvetica, sans-serif" font-weight="700">
    <text x="68" y="35" font-size="14">z</text>
    <text x="77" y="25" font-size="10">z</text>
  </g>`;

const grumpy = `
  <path d="M32 33 L45 37" stroke="${NAVY}" stroke-width="3" stroke-linecap="round"/>
  <path d="M64 33 L51 37" stroke="${NAVY}" stroke-width="3" stroke-linecap="round"/>
  <circle cx="39" cy="44" r="5.5" fill="#fff" stroke="${NAVY}" stroke-width="2"/>
  <circle cx="57" cy="44" r="5.5" fill="#fff" stroke="${NAVY}" stroke-width="2"/>
  <circle cx="39" cy="45" r="2.8" fill="${NAVY}"/>
  <circle cx="57" cy="45" r="2.8" fill="${NAVY}"/>
  <path d="M41 66 Q48 60 55 66" fill="none" stroke="${NAVY}" stroke-width="3" stroke-linecap="round"/>
  <g transform="translate(72 22)">
    <circle r="11" fill="#fff" stroke="${NAVY}" stroke-width="2.5"/>
    <path d="M0 -6 V0 L4.5 3" fill="none" stroke="${ORANGE_DARK}" stroke-width="2.5" stroke-linecap="round"/>
  </g>`;

// Bus seen from the side, nose on the right.
const side = wrap(`
  <rect x="10" y="26" width="76" height="40" rx="10" fill="${ORANGE}" stroke="${NAVY}" stroke-width="3"/>
  <path d="M70 31 H76 Q81 31 81 37 V46 H70 Z" fill="${SKY}" stroke="${NAVY}" stroke-width="2.5" stroke-linejoin="round"/>
  <rect x="17" y="32" width="14" height="13" rx="3" fill="${SKY}" stroke="${NAVY}" stroke-width="2"/>
  <rect x="35" y="32" width="14" height="13" rx="3" fill="${SKY}" stroke="${NAVY}" stroke-width="2"/>
  <rect x="53" y="32" width="12" height="13" rx="3" fill="${SKY}" stroke="${NAVY}" stroke-width="2"/>
  <circle cx="75" cy="38.5" r="3.6" fill="#fff" stroke="${NAVY}" stroke-width="1.6"/>
  <circle cx="76.4" cy="39" r="1.9" fill="${NAVY}"/>
  <path d="M70 54 Q75 58 80 54" fill="none" stroke="${NAVY}" stroke-width="2.5" stroke-linecap="round"/>
  <rect x="10" y="51" width="56" height="4" fill="${NAVY}" opacity="0.85"/>
  <circle cx="84" cy="59" r="2.5" fill="#fff" stroke="${NAVY}" stroke-width="1.5"/>
  <circle cx="27" cy="67" r="8" fill="${NAVY}"/>
  <circle cx="27" cy="67" r="3" fill="#fff"/>
  <circle cx="67" cy="67" r="8" fill="${NAVY}"/>
  <circle cx="67" cy="67" r="3" fill="#fff"/>
  <path d="M2 40 H7 M0 47 H6 M3 54 H7" stroke="${NAVY}" stroke-width="2" stroke-linecap="round" opacity="0.6"/>`);

const outDir = new URL('../public/cav/', import.meta.url);
await mkdir(outDir, { recursive: true });
const out = (name) => new URL(name, outDir).pathname.slice(1);
const png = (svg, name, mirror = false) => {
  let img = sharp(Buffer.from(svg)).resize(96, 96);
  if (mirror) img = img.flop();
  return img.png({ compressionLevel: 9 }).toFile(out(name));
};

await png(front(awake), 'front.png');
await png(front(asleep), 'sleep.png');
await png(front(grumpy), 'late.png');
await png(side, 'right.png');
await png(side, 'left.png', true);

console.log('Cav mode faces written to public/cav/');
