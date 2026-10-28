import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PngJob {
  html: string;
  width: number;
  height: number;
  out: string;
}

/** Renders HTML pages to PNG files with Playwright's Chromium (the browser Playwright installs, or CHROMIUM_PATH). */
export async function renderPngs(jobs: PngJob[]): Promise<void> {
  if (!jobs.length) return;
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    executablePath: process.env.AOM_CHROMIUM_PATH || undefined,
    args: ['--font-render-hinting=none'],
  });
  try {
    for (const job of jobs) {
      const page = await browser.newPage({
        viewport: { width: job.width, height: job.height },
        deviceScaleFactor: 1,
      });
      try {
        await page.setContent(job.html, { waitUntil: 'load' });
        mkdirSync(dirname(job.out), { recursive: true });
        await page.screenshot({ path: job.out, type: 'png' });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}
