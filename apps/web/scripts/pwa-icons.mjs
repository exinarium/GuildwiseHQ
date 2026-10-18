// Renders the PWA icons (public/icons/*.png) from the brand mark with the Chromium that Playwright (e2e) installs.
// The PNGs are committed; run `node apps/web/scripts/pwa-icons.mjs` only when the brand mark changes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('@playwright/test', { paths: [here('../../../e2e/')] }));

const NAVY = '#0D1220';
// The mark of public/favicon.svg without its rounded tile.
const MARK = `<path d="M47.56 21.10A19 19 0 1 0 50.71 35.30" fill="none" stroke="#FFFFFF" stroke-width="9"/><path d="M32 32H55" stroke="#FFFFFF" stroke-width="9"/><circle cx="32" cy="32" r="7.6" fill="#D4F24A"/>`;
// "any": the rounded tile of the favicon. "maskable": full-bleed navy, mark inside the 80% safe zone (the OS crops to its own shape).
const svg = {
  any: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${NAVY}"/>${MARK}</svg>`,
  maskable: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${NAVY}"/><g transform="translate(6.4 6.4) scale(0.8)">${MARK}</g></svg>`,
};
const jobs = [
  ['icon-192.png', 192, 'any'],
  ['icon-512.png', 512, 'any'],
  ['icon-maskable-512.png', 512, 'maskable'],
];

const out = here('../public/icons/');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [file, size, kind] of jobs) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<body style="margin:0;background:transparent"><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg[kind]).toString('base64')}"></body>`,
    );
    writeFileSync(out + file, await page.screenshot({ omitBackground: true, type: 'png' }));
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('wrote', jobs.map((j) => j[0]).join(', '));
