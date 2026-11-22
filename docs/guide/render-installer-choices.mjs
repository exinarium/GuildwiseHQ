#!/usr/bin/env node
// Makes docs/guide/assets/installer-choices.jpg: the installer's real "one screen" text (apps/runner/src/setup/screen.ts)
// on plain example names, drawn in a terminal-looking page and photographed with Playwright (e2e workspace).
// Usage: node docs/guide/render-installer-choices.mjs
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = `
import { randomUUID } from 'node:crypto';
import { DEFAULT_POLICY } from './src/policy/schema.ts';
import { initialChoices } from './src/setup/choices.ts';
import { parseSetupOptions } from './src/setup/options.ts';
import { renderScreen, SCREEN_PROMPT } from './src/setup/screen.ts';
const c = initialChoices({
  current: structuredClone(DEFAULT_POLICY),
  orgs: [
    { orgId: randomUUID(), orgName: 'Acme Law', role: 'Owner', devopsAgentId: randomUUID(), devopsAgentName: 'Dana' },
    { orgId: randomUUID(), orgName: 'Smith & Co', role: 'Member', devopsAgentId: randomUUID(), devopsAgentName: 'Sam' },
  ],
  repos: [{ url: 'https://github.com/acme/website.git', name: 'acme-website' }],
  opts: parseSetupOptions({}, {}),
  platform: 'linux',
});
console.log([...renderScreen(c), SCREEN_PROMPT].join('\\n'));
`;
const text = execFileSync('npx', ['tsx', '-e', script], { cwd: path.join(repo, 'apps/runner'), encoding: 'utf8' }).trimEnd();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = `<body style="margin:0;background:#e9ebf0;padding:28px">
<div style="width:1144px;border-radius:10px;overflow:hidden;box-shadow:0 4px 18px #0004">
<div style="background:#2d2f36;color:#c8ccd4;font:13px sans-serif;padding:9px 14px">Terminal</div>
<pre style="margin:0;background:#16181d;color:#e6e8ec;font:15px/1.5 'DejaVu Sans Mono',monospace;padding:20px 24px;white-space:pre">${esc(text)}<span style="background:#e6e8ec"> </span></pre></div></body>`;
const { chromium } = createRequire(path.join(repo, 'e2e/package.json'))('@playwright/test');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 600 }, deviceScaleFactor: 1 });
await page.setContent(html);
const out = path.join(repo, 'docs/guide/assets/installer-choices.jpg');
await page.locator('div').first().screenshot({ path: out, type: 'jpeg', quality: 88 });
await browser.close();
console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);
