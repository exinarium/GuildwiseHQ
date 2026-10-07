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

// Tall pictures are limited by the guide's CSS (max-height), so nothing is cut here. Phone shots keep their size.
fs.mkdirSync(OUT, { recursive: true });
let total = 0;
let count = 0;
const produced = new Set();

// Page shots are taken at a fixed height: cut the empty band at the bottom (uniform background), keep 28 px of air.
async function trimBottom(buf) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const px = (x, y) => y * width * channels + x * channels;
  const bg = [data[px(width - 1, height - 1)], data[px(width - 1, height - 1) + 1], data[px(width - 1, height - 1) + 2]];
  let last = height - 1;
  rows: for (; last > 0; last--) {
    for (let x = 0; x < width; x += 2) {
      const o = px(x, last);
      if (Math.abs(data[o] - bg[0]) + Math.abs(data[o + 1] - bg[1]) + Math.abs(data[o + 2] - bg[2]) > 12) break rows;
    }
  }
  const keep = Math.min(height, last + 28);
  if (height - keep < 60) return buf;
  return sharp(buf).extract({ left: 0, top: 0, width, height: keep }).png().toBuffer();
}
for (const f of fs.readdirSync(RAW).filter((x) => x.endsWith('.png')).sort()) {
  const name = f.replace(/\.png$/, '');
  const meta = await sharp(path.join(RAW, f)).metadata();
  let img = sharp(path.join(RAW, f)).flatten({ background: '#ffffff' });
  if ((meta.width ?? 0) > 1600) img = img.resize({ width: 1600 });
  let flat = await img.png().toBuffer();
  flat = await trimBottom(flat);
  const write = async (buf, out) => {
    const info = await sharp(buf).jpeg({ quality: 80, mozjpeg: true }).toFile(path.join(OUT, `${out}.jpg`));
    produced.add(`${out}.jpg`);
    total += info.size;
    count++;
    console.log(out.padEnd(30), `${info.width}x${info.height}`.padStart(10), `${Math.round(info.size / 1024)}K`.padStart(6));
  };
  await write(flat, name);
}
console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB, ${count} figures`);
for (const f of fs.readdirSync(OUT)) if (f !== 'fonts' && !f.endsWith('.svg') && !produced.has(f)) { fs.rmSync(path.join(OUT, f)); console.log('removed stale', f); }
