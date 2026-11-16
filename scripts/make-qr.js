// Makes QR codes that open the live site, for slides and posters at bus stops.
// Run with: npm run qr   (files land in demo/qr/)
//
//   qr-hoomaps.png        navy QR with the HooMaps bus icon in the middle
//   qr-hoomaps-plain.png  same, no icon (backup if a phone camera struggles)
//   qr-hoomaps.svg        sharp at any size (for slides)
//   qr-card.png           slide/poster card: QR + name + address + install tip

import QRCode from 'qrcode';
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';

const URL_TO_OPEN = 'https://hoomaps.onrender.com';
const NAVY = '#232d4b';
const ORANGE = '#e57200';

// "H" = highest error correction: up to ~30% of the code can be covered
// (by the icon) and it still scans.
const qr = QRCode.create(URL_TO_OPEN, { errorCorrectionLevel: 'H' });
const n = qr.modules.size;
const QUIET = 4; // blank border, in squares (scanners need it)
const total = n + QUIET * 2;

function qrSvg({ withIcon, px = 1024 }) {
  const cell = px / total;
  let squares = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) {
        squares += `<rect x="${((c + QUIET) * cell).toFixed(2)}" y="${((r + QUIET) * cell).toFixed(2)}" width="${(cell + 0.5).toFixed(2)}" height="${(cell + 0.5).toFixed(2)}"/>`;
      }
    }
  }
  // Icon covers ~22% of the width (well under the 30% the code can lose).
  const box = px * 0.22;
  const x = (px - box) / 2;
  const s = box / 512; // the bus is drawn on a 512 grid, like the app icon
  const icon = withIcon
    ? `<rect x="${x - px * 0.015}" y="${x - px * 0.015}" width="${box + px * 0.03}" height="${box + px * 0.03}" rx="${box * 0.25}" fill="#fff"/>
  <g transform="translate(${x} ${x}) scale(${s})">
    <rect width="512" height="512" rx="112" fill="${NAVY}"/>
    <rect x="176" y="356" width="44" height="46" rx="12" fill="${ORANGE}"/>
    <rect x="292" y="356" width="44" height="46" rx="12" fill="${ORANGE}"/>
    <rect x="150" y="110" width="212" height="262" rx="40" fill="${ORANGE}"/>
    <rect x="204" y="128" width="104" height="14" rx="7" fill="${NAVY}"/>
    <rect x="174" y="156" width="164" height="106" rx="16" fill="#fff"/>
    <circle cx="198" cy="312" r="16" fill="#fff"/>
    <circle cx="314" cy="312" r="16" fill="#fff"/>
    <rect x="234" y="304" width="44" height="16" rx="8" fill="${NAVY}"/>
  </g>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" width="${px}" height="${px}">
  <rect width="${px}" height="${px}" fill="#fff"/>
  <g fill="${NAVY}" shape-rendering="crispEdges">${squares}</g>
  ${icon}
</svg>`;
}

// A card for a slide or a printed sign: 1200 x 1600.
function cardSvg() {
  const inner = qrSvg({ withIcon: true, px: 900 })
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1600" width="1200" height="1600">
  <rect width="1200" height="1600" fill="${NAVY}"/>
  <text x="600" y="170" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="120" font-weight="700" fill="#fff">Hoo<tspan fill="${ORANGE}">Maps</tspan></text>
  <text x="600" y="250" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="46" fill="#fff">UVA + CAT buses, live, in one map</text>
  <rect x="130" y="320" width="940" height="940" rx="48" fill="#fff"/>
  <g transform="translate(150 340)">${inner}</g>
  <text x="600" y="1370" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="58" font-weight="700" fill="${ORANGE}">hoomaps.onrender.com</text>
  <text x="600" y="1460" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="40" fill="#fff">Scan with your camera · then Share → Add to Home Screen</text>
</svg>`;
}

const outDir = new URL('../demo/qr/', import.meta.url);
await mkdir(outDir, { recursive: true });
const out = (name) => new URL(name, outDir).pathname.slice(1);

await writeFile(out('qr-hoomaps.svg'), qrSvg({ withIcon: true }));
await sharp(Buffer.from(qrSvg({ withIcon: true }))).png().toFile(out('qr-hoomaps.png'));
await sharp(Buffer.from(qrSvg({ withIcon: false }))).png().toFile(out('qr-hoomaps-plain.png'));
await sharp(Buffer.from(cardSvg())).png().toFile(out('qr-card.png'));

console.log(`QR codes for ${URL_TO_OPEN} written to demo/qr/`);
