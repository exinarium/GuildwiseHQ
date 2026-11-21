import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chromiumPdfRenderer, headlessShellInstalled } from '../src/storage/pdf.ts';

/**
 * UAT 1.10.0 bug 3: `guildwise-runner pdf-renderer install` (and the runner's background repair) fetch Chrome Headless Shell
 * only, but the status and the launch checked the FULL Chromium's path: doctor said "PDF renderer: missing" while the
 * runner log said "browser installed", on every start.
 */
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'aom-pdfshell-'));
  dirs.push(d);
  return d;
};
const rev = (
  JSON.parse(
    readFileSync(
      join(dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'browsers.json'),
      'utf8',
    ),
  ) as { browsers: Array<{ name: string; revision: string }> }
).browsers.find((b) => b.name === 'chromium-headless-shell')?.revision as string;

describe('the PDF renderer is ready when the headless shell it installs is there', () => {
  it('status: ready with only chromium_headless_shell-<rev> (what install --only-shell writes), not before it completed', async () => {
    const b = tmp();
    const r = chromiumPdfRenderer({ browsersPath: b });
    expect((await r.status()).ready).toBe(false);
    mkdirSync(join(b, `chromium_headless_shell-${rev}`), { recursive: true });
    expect((await r.status()).ready).toBe(false); // a download that did not finish
    writeFileSync(join(b, `chromium_headless_shell-${rev}`, 'INSTALLATION_COMPLETE'), '');
    expect((await r.status()).ready).toBe(true);
    expect(existsSync(join(b, `chromium-${rev}`))).toBe(false);
    await r.close();
  });

  it('another revision, a bad browsers.json or a missing one is not ready', () => {
    const b = tmp();
    mkdirSync(join(b, 'chromium_headless_shell-1'), { recursive: true });
    writeFileSync(join(b, 'chromium_headless_shell-1', 'INSTALLATION_COMPLETE'), '');
    expect(headlessShellInstalled(b)).toBe(rev === '1');
    const j = join(tmp(), 'browsers.json');
    writeFileSync(j, '{"browsers":[{"name":"chromium-headless-shell","revision":"../x"}]}');
    expect(headlessShellInstalled(b, j)).toBe(false);
    writeFileSync(j, 'not json');
    expect(headlessShellInstalled(b, j)).toBe(false);
    expect(headlessShellInstalled(b, join(tmp(), 'none.json'))).toBe(false);
  });

  const cached = join(userInfo().homedir, '.cache', 'ms-playwright', `chromium_headless_shell-${rev}`);
  it.skipIf(!existsSync(join(cached, 'INSTALLATION_COMPLETE')))(
    'renders a PDF from a browsers folder that holds only the headless shell (real browser)',
    async () => {
      const b = tmp();
      symlinkSync(cached, join(b, `chromium_headless_shell-${rev}`));
      const r = chromiumPdfRenderer({ browsersPath: b, idleMs: 60_000 });
      try {
        expect((await r.status()).ready).toBe(true);
        const pdf = await r.render('<!doctype html><p>hello</p>', AbortSignal.timeout(30_000));
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      } finally {
        await r.close();
      }
    },
    60_000,
  );
});
