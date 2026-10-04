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

// Tall pictures are cut into an upper and a lower half (name.jpg, name-b.jpg, 30 px overlap) so the text stays legible on A4;
// a few are cut to their top part (CROP_TOP: name -> height in px).
export const SPLIT = ['card-new', 'card-new-errors', 'card-new-missing', 'card-conflict', 'card-evidence', 'card-outbound-edited', 'card-outbound-failed', 'card-published', 'card-research-rework', 'desk', 'desk-maya', 'feed', 'workstations', 'project-settings', 'project-settings-maya', 'org-workflow-editor', 'org-role-editor', 'dlg-edit-card', 'admin', 'hr', 'hr-maya'];
const CROP_TOP = { 'chat-ba': 520, 'chat-ba-2': 520, 'chat-reviewer': 420, 'chat-start': 380 };
fs.mkdirSync(OUT, { recursive: true });
let total = 0;
let count = 0;
const produced = new Set();
for (const f of fs.readdirSync(RAW).filter((x) => x.endsWith('.png')).sort()) {
  const name = f.replace(/\.png$/, '');
  const meta = await sharp(path.join(RAW, f)).metadata();
  let img = sharp(path.join(RAW, f)).flatten({ background: '#ffffff' });
  // the centred sign-in style pages are mostly white: cut the empty margins and keep a little air
  if (/^(login|login-error|invite-accept|invite-errors|invite-invalid)$/.test(name)) {
    img = sharp(await img.trim({ threshold: 8 }).png().toBuffer()).extend({ top: 24, bottom: 24, left: 24, right: 24, background: '#ffffff' });
  }
  if ((meta.width ?? 0) > 1600) img = img.resize({ width: 1600 });
  const flat = await img.png().toBuffer();
  const fm = await sharp(flat).metadata();
  const write = async (buf, out) => {
    const info = await sharp(buf).jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(OUT, `${out}.jpg`));
    produced.add(`${out}.jpg`);
    total += info.size;
    count++;
    console.log(out.padEnd(30), `${info.width}x${info.height}`.padStart(10), `${Math.round(info.size / 1024)}K`.padStart(6));
  };
  if (CROP_TOP[name] && fm.height > CROP_TOP[name]) {
    await write(await sharp(flat).extract({ left: 0, top: 0, width: fm.width, height: CROP_TOP[name] }).png().toBuffer(), name);
  } else if (SPLIT.includes(name) && fm.height > 700) {
    const half = Math.ceil(fm.height / 2);
    await write(await sharp(flat).extract({ left: 0, top: 0, width: fm.width, height: half + 15 }).png().toBuffer(), name);
    await write(await sharp(flat).extract({ left: 0, top: half - 15, width: fm.width, height: fm.height - half + 15 }).png().toBuffer(), `${name}-b`);
  } else {
    await write(flat, name);
  }
}
console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB, ${count} figures`);
for (const f of fs.readdirSync(OUT)) if (!produced.has(f)) { fs.rmSync(path.join(OUT, f)); console.log('removed stale', f); }
