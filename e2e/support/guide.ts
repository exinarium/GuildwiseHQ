import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { E2E_DIR, ROOT } from './env.ts';

// The page functions below run in the browser; the e2e project has no DOM typings.
declare const document: any;
declare const NodeFilter: any;

/** Raw PNG screenshots of the user guide (docs/guide/prepare-assets.mjs turns them into the figures). */
export const RAW_DIR = join(ROOT, 'docs/guide/raw');

/** Demo people. Only fake addresses (demo.local, example.com). */
export const PIETER = { email: 'pieter@demo.local', name: 'Pieter Demo', password: 'pieter-demo-pass-2026' };
export const MAYA = { email: 'maya@demo.local', name: 'Maya Demo', password: 'maya-demo-pass-2026' };
export const ADMIN_DEMO = { email: 'admin@demo.local', name: 'Admin Demo' };

/** State of the seeded demo world, kept between runs (AOM_GUIDE_KEEP / AOM_GUIDE_REUSE). */
const STATE_FILE = join(E2E_DIR, 'guide-state.json');
export interface GuideState {
  done: Record<string, boolean>;
  ids: Record<string, string>;
}
export function loadState(): GuideState {
  if (!existsSync(STATE_FILE)) return { done: {}, ids: {} };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as GuideState;
}
export function saveState(s: GuideState): void {
  mkdirSync(E2E_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

/**
 * Replaces the machine-specific paths of the test stack with demo ones in the text and the input values of the page,
 * so no screenshot shows /tmp/... paths.
 */
export async function maskDemo(page: Page): Promise<void> {
  await page.evaluate((dir) => {
    const map: Array<[RegExp, string]> = [
      [new RegExp(`${dir}/origin/toy\\.git`, 'g'), 'https://git.example.com/demo/web.git'],
      [
        new RegExp(`${dir}/vaults/(work|personal|project)/origin\\.git`, 'g'),
        'git@git.example.com:pieter/$1-vault.git',
      ],
      [new RegExp(`${dir}/guide-[a-z]+/vaults/[^\\s)]*`, 'g'), '/home/demo/.aom-runner/vaults/vault'],
      [new RegExp(`${dir}/repos/toy`, 'g'), '/home/demo/src/web'],
      [new RegExp(`${dir}/[^\\s)"']*`, 'g'), '/home/demo'],
    ];
    const extra: Array<[RegExp, string]> = [
      [/WIN-HOST/g, 'desktop-wsl'],
      [/unsandboxed \(forced by AOM_RUNNER_MOCK_SANDBOX\)/g, 'native Windows, unsandboxed by choice'],
    ];
    const fix = (s: string): string => [...map, ...extra].reduce((acc, [re, to]) => acc.replace(re, to), s);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue ?? '';
      if (t.includes(dir) || t.includes('WIN-HOST') || t.includes('AOM_RUNNER_MOCK_SANDBOX'))
        n.nodeValue = fix(t);
    }
    for (const el of Array.from(document.querySelectorAll('input,textarea'))) {
      const input = el as any;
      if (input.value?.includes(dir)) input.value = fix(input.value);
    }
  }, E2E_DIR);
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
  await maskDemo(page);
}

export interface SnapOptions {
  /** Screenshot of this element only (a dialog, a panel, a card). */
  sel?: Locator;
  /** Cut off the sticky top bar. */
  noHeader?: boolean;
  /** Maximum height in CSS pixels of a page shot (default 1600). */
  maxH?: number;
  /** Start of a page shot, in CSS pixels from the top (after the header cut). */
  top?: number;
  /** Horizontal crop of a page shot (for narrow centred pages). */
  cx?: { x: number; width: number };
  /** Explicit box for a page shot. */
  clip?: { x: number; y: number; width: number; height: number };
}

/** Takes docs/guide/raw/<name>.png: the page (height up to maxH), or one element. */
export async function snap(page: Page, name: string, o: SnapOptions = {}): Promise<void> {
  mkdirSync(RAW_DIR, { recursive: true });
  const path = join(RAW_DIR, `${name}.png`);
  await settle(page);
  if (o.sel) {
    await page.addStyleTag({ content: 'header { position: static !important; }' });
    await o.sel.scrollIntoViewIfNeeded();
    await o.sel.screenshot({ path });
    return;
  }
  const vw = page.viewportSize()?.width ?? 1280;
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  if (o.clip) {
    await page.screenshot({ path, fullPage: true, clip: o.clip });
    return;
  }
  const header = o.noHeader ? ((await page.locator('header').first().boundingBox())?.height ?? 0) : 0;
  const y = header + (o.top ?? 0);
  const height = Math.max(60, Math.min(o.maxH ?? 1600, total - y));
  await page.screenshot({
    path,
    fullPage: true,
    clip: { x: o.cx?.x ?? 0, y, width: o.cx?.width ?? vw, height },
  });
}

/** A board column cut to its cards (the column element itself is as tall as the whole board). */
export async function snapColumn(page: Page, name: string, col: Locator, maxH = 640): Promise<void> {
  mkdirSync(RAW_DIR, { recursive: true });
  await settle(page);
  await col.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    (document as any).querySelector('header').style.position = 'static';
  });
  const box = await col.boundingBox();
  const list = await col.locator('ul').boundingBox();
  if (!box || !list) throw new Error(`column ${name} not found`);
  const height = Math.min(maxH, list.y + list.height - box.y + 10);
  await page.screenshot({
    path: join(RAW_DIR, `${name}.png`),
    clip: { x: box.x, y: box.y, width: box.width, height },
  });
}
