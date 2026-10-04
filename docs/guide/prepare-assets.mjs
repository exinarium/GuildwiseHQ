#!/usr/bin/env node
// Turns the raw PNG screenshots of the guide (docs/guide/raw, made by the `guide` Playwright project, see README.md)
// into the JPEG figures in docs/guide/assets/. Needs sharp, installed in a scratch folder (deliberately not a
// dependency of the repository):
//   mkdir -p /tmp/guide-tools && cd /tmp/guide-tools && npm init -y && npm i sharp
// Usage: node docs/guide/prepare-assets.mjs
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(here, 'raw');
const OUT = path.join(here, 'assets');
const TOOLS = process.env.GUIDE_TOOLS || '/tmp/guide-tools';
const sharp = createRequire(path.join(TOOLS, 'package.json'))('sharp');

fs.mkdirSync(OUT, { recursive: true });
let total = 0;
let count = 0;
const produced = new Set();
for (const f of fs.readdirSync(RAW).filter((x) => x.endsWith('.png')).sort()) {
  const name = f.replace(/\.png$/, '');
  const meta = await sharp(path.join(RAW, f)).metadata();
  let img = sharp(path.join(RAW, f)).flatten({ background: '#ffffff' });
  // one page shot that was taken before the form pictures were cropped at capture time
  if (name === 'card-new-missing') img = sharp(await img.extract({ left: 230, top: 50, width: 820, height: Math.min(1500, (meta.height ?? 1500) - 50) }).png().toBuffer());
  // the centred sign-in style pages are mostly white: cut the empty margins and keep a little air
  if (/^(login|login-error|invite-accept|invite-errors|invite-invalid)$/.test(name)) {
    img = sharp(await img.trim({ threshold: 8 }).png().toBuffer()).extend({ top: 24, bottom: 24, left: 24, right: 24, background: '#ffffff' });
  }
  if ((meta.width ?? 0) > 1600) img = img.resize({ width: 1600 });
  const info = await img.jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(OUT, `${name}.jpg`));
  produced.add(`${name}.jpg`);
  total += info.size;
  count++;
  console.log(name.padEnd(30), `${info.width}x${info.height}`.padStart(10), `${Math.round(info.size / 1024)}K`.padStart(6));
}
console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB, ${count} figures`);
for (const f of fs.readdirSync(OUT)) if (!produced.has(f)) { fs.rmSync(path.join(OUT, f)); console.log('removed stale', f); }
