import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Why a PDF copy could not be made. The code is all that is ever logged or returned: never the HTML. */
export type PdfFailure = 'pdf_unavailable' | 'pdf_failed' | 'pdf_timeout';

export class PdfError extends Error {
  constructor(readonly code: PdfFailure) {
    super(code);
    this.name = 'PdfError';
  }
}

export interface PdfRenderer {
  /** HTML in, PDF bytes out. Throws PdfError. Never logs or returns the HTML in an error. */
  render(html: string, signal: AbortSignal): Promise<Buffer>;
  status(): Promise<{ ready: boolean; version?: string }>;
  install(opts: { withDeps: boolean; log: (line: string) => void; signal?: AbortSignal }): Promise<void>;
  close(): Promise<void>;
}

export interface ChromiumPdfOptions {
  /** `<data dir>/browsers`: the runner's own copy of the browser, apart from any developer toolchain. */
  browsersPath: string;
  /** The browser is closed after this long without a render (default 10 minutes). */
  idleMs?: number;
  /** Renders in parallel (default 2). */
  maxConcurrent?: number;
  /** Test seam: a browser binary at this path instead of the one playwright-core resolves. */
  executablePath?: string;
  /** Test seam: the cli script `install` runs instead of playwright-core's cli.js. */
  cli?: string;
}

// Only the parts of playwright-core the renderer touches.
interface PwPage {
  setContent(html: string, o: { waitUntil: 'load'; timeout: number }): Promise<void>;
  emulateMedia(o: { media: 'print' }): Promise<void>;
  pdf(o: Record<string, unknown>): Promise<Buffer>;
}
interface PwContext {
  route(url: string, h: (r: { abort(): Promise<void> }) => unknown): Promise<void>;
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(o: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
  isConnected(): boolean;
  version(): string;
  on(ev: 'disconnected', h: () => void): void;
}
interface PwModule {
  chromium: {
    launch(o: Record<string, unknown>): Promise<PwBrowser>;
    executablePath(): string;
  };
}

const LAUNCH_ARGS = [
  '--disable-gpu',
  '--no-first-run',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-component-update',
  '--disable-default-apps',
];

const FOOTER =
  '<div style="font-size:8px;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>';

/** Loads playwright-core on demand so a runner without a browser never pays for it. */
async function loadPlaywright(browsersPath: string): Promise<PwModule> {
  // playwright-core reads the variable when it loads; keep it out of the runner-wide environment
  // so child processes (other Playwright runs, toolchain commands) are not redirected.
  const had = Object.prototype.hasOwnProperty.call(process.env, 'PLAYWRIGHT_BROWSERS_PATH');
  const old = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  try {
    const name = 'playwright-core';
    return (await import(name)) as unknown as PwModule;
  } finally {
    if (had) process.env.PLAYWRIGHT_BROWSERS_PATH = old;
    else delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  }
}

/** Path of playwright-core's cli.js, for the install command. */
export function playwrightCli(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    return join(dirname(req.resolve('playwright-core/package.json')), 'cli.js');
  } catch {
    return undefined;
  }
}

/** Chrome Headless Shell through playwright-core: prints the received HTML with scripts and network off. */
export function chromiumPdfRenderer(o: ChromiumPdfOptions): PdfRenderer {
  const idleMs = o.idleMs ?? 10 * 60_000;
  const maxConcurrent = o.maxConcurrent ?? 2;
  let browser: PwBrowser | undefined;
  let launching: Promise<PwBrowser> | undefined;
  let idle: NodeJS.Timeout | undefined;
  let running = 0;
  const waiters: Array<() => void> = [];

  const acquire = (signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new PdfError('pdf_timeout'));
      if (running < maxConcurrent) {
        running++;
        return resolve();
      }
      const go = () => {
        signal.removeEventListener('abort', onAbort);
        running++;
        resolve();
      };
      const onAbort = () => {
        const i = waiters.indexOf(go);
        if (i >= 0) waiters.splice(i, 1);
        reject(new PdfError('pdf_timeout'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      waiters.push(go);
    });
  const release = () => {
    running--;
    waiters.shift()?.();
  };

  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      if (running === 0) void close();
      else armIdle();
    }, idleMs);
    idle.unref?.();
  };

  async function launch(): Promise<PwBrowser> {
    if (browser?.isConnected()) return browser;
    launching ??= (async () => {
      let pw: PwModule;
      try {
        pw = await loadPlaywright(o.browsersPath);
        if (!existsSync(o.executablePath ?? pw.chromium.executablePath())) throw new Error('missing');
        const b = await pw.chromium.launch({
          headless: true,
          args: LAUNCH_ARGS,
          ...(o.executablePath ? { executablePath: o.executablePath } : {}),
        });
        b.on('disconnected', () => {
          if (browser === b) browser = undefined;
        });
        browser = b;
        return b;
      } catch {
        throw new PdfError('pdf_unavailable');
      } finally {
        launching = undefined;
      }
    })();
    return launching;
  }

  async function close(): Promise<void> {
    if (idle) clearTimeout(idle);
    idle = undefined;
    const b = browser;
    browser = undefined;
    try {
      await b?.close();
    } catch {
      // already gone
    }
  }

  return {
    async render(html, signal) {
      await acquire(signal);
      try {
        const b = await launch();
        const timeout = 30_000;
        let ctx: PwContext | undefined;
        const work = (async () => {
          ctx = await b.newContext({
            javaScriptEnabled: false,
            offline: true,
            serviceWorkers: 'block',
            acceptDownloads: false,
          });
          // Every request is refused; an embedded data: image is not routed and still loads.
          await ctx.route('**/*', (r) => r.abort());
          const page = await ctx.newPage();
          await page.setContent(html, { waitUntil: 'load', timeout });
          await page.emulateMedia({ media: 'print' });
          return await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate: FOOTER,
          });
        })();
        const aborted = new Promise<never>((_, reject) => {
          const fire = () => reject(new PdfError('pdf_timeout'));
          if (signal.aborted) fire();
          else signal.addEventListener('abort', fire, { once: true });
        });
        try {
          const pdf = await Promise.race([work, aborted]);
          return Buffer.from(pdf);
        } finally {
          work.catch(() => undefined);
          try {
            await ctx?.close();
          } catch {
            // browser already gone
          }
        }
      } catch (err) {
        if (err instanceof PdfError) throw err;
        if (signal.aborted) throw new PdfError('pdf_timeout');
        if (browser && !browser.isConnected()) browser = undefined;
        throw new PdfError('pdf_failed');
      } finally {
        release();
        if (browser) armIdle();
      }
    },

    async status() {
      try {
        const pw = await loadPlaywright(o.browsersPath);
        const exe = o.executablePath ?? pw.chromium.executablePath();
        if (!existsSync(exe)) return { ready: false };
        return { ready: true, ...(browser ? { version: browser.version() } : {}) };
      } catch {
        return { ready: false };
      }
    },

    async install({ withDeps, log, signal }) {
      const cli = o.cli ?? playwrightCli();
      if (!cli) throw new PdfError('pdf_unavailable');
      const { execa } = await import('execa');
      const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: o.browsersPath };
      const run = async (args: string[]) => {
        if (signal?.aborted) throw new PdfError('pdf_failed');
        const r = await execa(process.execPath, [cli, ...args], {
          env,
          reject: false,
          all: true,
          ...(signal ? { cancelSignal: signal } : {}),
          forceKillAfterDelay: 2000,
        });
        if (r.all) for (const l of String(r.all).split('\n')) if (l.trim()) log(l);
        if (signal?.aborted || r.exitCode !== 0) throw new PdfError('pdf_failed');
      };
      if (withDeps && process.platform === 'linux') await run(['install-deps', 'chromium-headless-shell']);
      await run(['install', '--only-shell', 'chromium']);
    },

    close,
  };
}
