import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PdfError, type PdfRenderer, chromiumPdfRenderer } from '../src/storage/pdf.ts';
import { startHarness, type Harness } from './harness.ts';

type InstallOpts = Parameters<PdfRenderer['install']>[0];

const fake = (ready: boolean, install: (o: InstallOpts) => Promise<void>) => {
  const calls = { status: 0, install: 0 };
  const pdf: PdfRenderer = {
    render: async () => Buffer.from('x'),
    status: async () => {
      calls.status++;
      return { ready };
    },
    install: async (o) => {
      calls.install++;
      await install(o);
    },
    close: async () => undefined,
  };
  return { pdf, calls };
};

describe('PDF renderer repair at runner start', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  it('makes no status or install call by default under tests', async () => {
    const { pdf, calls } = fake(false, async () => undefined);
    h = await startHarness({}, { pdfRenderer: pdf });
    expect(calls).toEqual({ status: 0, install: 0 });
  });

  it('installs once when the browser is missing and pdfRepair is on', async () => {
    const { pdf, calls } = fake(false, async () => undefined);
    h = await startHarness({}, { pdfRenderer: pdf, pdfRepair: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.install).toBe(1);
  });

  it('does not install when the browser is ready', async () => {
    const { pdf, calls } = fake(true, async () => undefined);
    h = await startHarness({}, { pdfRenderer: pdf, pdfRepair: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual({ status: 1, install: 0 });
  });

  it('stop aborts a running install and waits until it has settled', async () => {
    let signal: AbortSignal | undefined;
    let settled = false;
    const { pdf, calls } = fake(false, (o) => {
      signal = o.signal;
      return new Promise<void>((_, reject) =>
        o.signal?.addEventListener('abort', () =>
          setTimeout(() => {
            settled = true;
            reject(new PdfError('pdf_failed'));
          }, 30),
        ),
      );
    });
    h = await startHarness({}, { pdfRenderer: pdf, pdfRepair: true });
    for (let i = 0; i < 100 && calls.install === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
    await h.runner.stop();
    expect(signal?.aborted).toBe(true);
    expect(settled).toBe(true);
    await h.server.close();
    h = undefined;
  });

  it('whenSettled resolves at once for an unknown shift', async () => {
    h = await startHarness();
    await expect(h.runner.supervisor.whenSettled('nope')).resolves.toBeUndefined();
    await expect(h.runner.supervisor.settledAll()).resolves.toBeUndefined();
  });
});

describe('chromiumPdfRenderer install cancellation', () => {
  it('kills the installer when the signal aborts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-pdf-cli-'));
    mkdirSync(join(dir, 'b'));
    const cli = join(dir, 'cli.js');
    const pidFile = join(dir, 'pid');
    writeFileSync(
      cli,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    const pdf = chromiumPdfRenderer({ browsersPath: join(dir, 'b'), cli });
    const ac = new AbortController();
    const run = pdf.install({ withDeps: false, log: () => undefined, signal: ac.signal });
    const { existsSync, readFileSync } = await import('node:fs');
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 25));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    ac.abort();
    await expect(run).rejects.toBeInstanceOf(PdfError);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
