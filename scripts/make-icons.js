// Makes the app icons (PNG files) from one design written in SVG.
// Run with: npm run icons   (only needed again if the design changes)

import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';

const NAVY = '#232d4b';
const ORANGE = '#e57200';

// An orange bus, seen from the front, on a navy background.
// Everything important sits in the middle 80% so phones can crop the icon to a circle.
function iconSvg({ rounded }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${rounded ? 112 : 0}" fill="${NAVY}"/>
  <rect x="176" y="356" width="44" height="46" rx="12" fill="${ORANGE}"/>
  <rect x="292" y="356" width="44" height="46" rx="12" fill="${ORANGE}"/>
  <rect x="150" y="110" width="212" height="262" rx="40" fill="${ORANGE}"/>
  <rect x="204" y="128" width="104" height="14" rx="7" fill="${NAVY}"/>
  <rect x="174" y="156" width="164" height="106" rx="16" fill="#fff"/>
  <circle cx="198" cy="312" r="16" fill="#fff"/>
  <circle cx="314" cy="312" r="16" fill="#fff"/>
  <rect x="234" y="304" width="44" height="16" rx="8" fill="${NAVY}"/>
</svg>`;
}

const outDir = new URL('../public/icons/', import.meta.url);
await mkdir(outDir, { recursive: true });

const rounded = Buffer.from(iconSvg({ rounded: true }));
const square = Buffer.from(iconSvg({ rounded: false }));

await writeFile(new URL('icon.svg', outDir), rounded); // browser tab icon
await sharp(rounded).resize(192).png().toFile(new URL('icon-192.png', outDir).pathname.slice(1));
await sharp(rounded).resize(512).png().toFile(new URL('icon-512.png', outDir).pathname.slice(1));
// "Maskable" = full-bleed square; Android crops it into its own shape.
await sharp(square).resize(512).png().toFile(new URL('icon-maskable-512.png', outDir).pathname.slice(1));
// iPhone home screen icon; iOS rounds the corners itself.
await sharp(square).resize(180).png().toFile(new URL('apple-touch-icon.png', outDir).pathname.slice(1));

console.log('Icons written to public/icons/');
