// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('../../public/sw.js', import.meta.url)), 'utf8');
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../public/manifest.webmanifest', import.meta.url)), 'utf8'),
);

type Handler = (e: Record<string, unknown>) => void;
function load(
  opts: {
    windows?: Array<Record<string, unknown>>;
    badge?: boolean;
    caches?: unknown;
    fetch?: (req: unknown) => Promise<unknown>;
  } = {},
) {
  const handlers: Record<string, Handler> = {};
  const shown: Array<{ title: string; options: Record<string, any> }> = [];
  const setAppBadge = vi.fn(async () => undefined);
  const clearAppBadge = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => null);
  const self: Record<string, unknown> = {
    location: { origin: 'https://app.example.com' },
    addEventListener: (type: string, h: Handler) => {
      handlers[type] = h;
    },
    registration: {
      showNotification: async (title: string, options: Record<string, any>) => {
        shown.push({ title, options });
      },
    },
    navigator: opts.badge === false ? {} : { setAppBadge, clearAppBadge },
    clients: { matchAll: async () => opts.windows ?? [], openWindow, claim: async () => undefined },
    skipWaiting: vi.fn(),
  };
  vm.runInNewContext(
    source,
    {
      self,
      caches: opts.caches ?? {},
      URL,
      Response,
      fetch: opts.fetch ?? vi.fn(async () => new Response('ok')),
      Promise,
    },
    { filename: 'sw.js' },
  );
  const waits: Promise<unknown>[] = [];
  const fire = async (type: string, e: Record<string, unknown>) => {
    handlers[type]?.({ ...e, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  return { fire, shown, setAppBadge, clearAppBadge, openWindow, self, handlers };
}

describe('manifest', () => {
  it('is an installable standalone app with maskable icons', () => {
    expect(manifest).toMatchObject({ name: 'Guildwise', start_url: '/', scope: '/', display: 'standalone' });
    expect(manifest.icons.map((i: any) => `${i.sizes}/${i.purpose}`)).toEqual([
      '192x192/any',
      '512x512/any',
      '512x512/maskable',
    ]);
  });
});

describe('push', () => {
  it('shows the notification with tag and url and sets the app badge', async () => {
    const sw = load();
    await sw.fire('push', {
      data: {
        json: () => ({
          title: 'Approve TOY-3',
          body: 'Add login',
          tag: 'owner_approvals:c1',
          url: '/cards/TOY-3',
          badge: 4,
        }),
      },
    });
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]?.title).toBe('Approve TOY-3');
    expect(sw.shown[0]?.options).toMatchObject({
      body: 'Add login',
      tag: 'owner_approvals:c1',
      renotify: true,
      data: { url: '/cards/TOY-3' },
    });
    expect(sw.setAppBadge).toHaveBeenCalledWith(4);
  });

  it('clears the badge at zero and works where the badge API is missing', async () => {
    const sw = load();
    await sw.fire('push', {
      data: { json: () => ({ title: 'T', body: 'b', url: '/', tag: 't', badge: 0 }) },
    });
    expect(sw.clearAppBadge).toHaveBeenCalled();
    const bare = load({ badge: false });
    await bare.fire('push', {
      data: { json: () => ({ title: 'T', body: 'b', url: '/', tag: 't', badge: 2 }) },
    });
    expect(bare.shown).toHaveLength(1);
  });

  it('survives a payload that is not JSON', async () => {
    const sw = load();
    await sw.fire('push', {
      data: {
        json: () => {
          throw new Error('bad');
        },
        text: () => 'plain words',
      },
    });
    expect(sw.shown[0]?.options.body).toBe('plain words');
  });

  it('never opens another origin from a notification', async () => {
    const sw = load();
    await sw.fire('push', {
      data: { json: () => ({ title: 'T', body: '', url: 'https://evil.example.org/x', tag: 't', badge: 1 }) },
    });
    expect(sw.shown[0]?.options.data.url).toBe('/');
  });
});

describe('notificationclick', () => {
  const click = (url: string) => ({ notification: { close: vi.fn(), data: { url } } });

  it('focuses an open window and navigates it to the url', async () => {
    const navigate = vi.fn(async () => undefined);
    const win: Record<string, unknown> = { url: 'https://app.example.com/desk', navigate };
    win.focus = vi.fn(async () => win);
    const sw = load({ windows: [win] });
    await sw.fire('notificationclick', click('/cards/TOY-3'));
    expect(win.focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/cards/TOY-3');
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it('opens a window when none is open', async () => {
    const sw = load();
    const e = click('/desk#desk-item-1');
    await sw.fire('notificationclick', e);
    expect(e.notification.close).toHaveBeenCalled();
    expect(sw.openWindow).toHaveBeenCalledWith('/desk#desk-item-1');
  });
});

describe('fetch', () => {
  it('leaves api calls and non-GET requests to the network', () => {
    const sw = load();
    const respondWith = vi.fn();
    const ev = (url: string, method = 'GET', mode = 'cors') => ({
      request: { url, method, mode },
      respondWith,
    });
    sw.handlers.fetch?.(ev('https://app.example.com/api/desk'));
    sw.handlers.fetch?.(ev('https://app.example.com/ws'));
    sw.handlers.fetch?.(ev('https://app.example.com/anything', 'POST'));
    sw.handlers.fetch?.(ev('https://cdn.example.org/lib.js'));
    expect(respondWith).not.toHaveBeenCalled();
    sw.handlers.fetch?.(ev('https://app.example.com/desk', 'GET', 'navigate'));
    expect(respondWith).toHaveBeenCalledTimes(1);
  });

  it('never intercepts the help videos, their captions or the manifest (including Range requests)', () => {
    const sw = load();
    const respondWith = vi.fn();
    const ev = (url: string, headers: Record<string, string> = {}) => ({
      request: { url, method: 'GET', mode: 'no-cors', headers: new Headers(headers) },
      respondWith,
    });
    sw.handlers.fetch?.(ev('https://app.example.com/videos/desk.mp4?v=abc', { range: 'bytes=0-' }));
    sw.handlers.fetch?.(ev('https://app.example.com/videos/desk.vtt'));
    sw.handlers.fetch?.(ev('https://app.example.com/videos/manifest.json'));
    sw.handlers.fetch?.(ev('https://app.example.com/other.mp4', { range: 'bytes=10-20' }));
    expect(respondWith).not.toHaveBeenCalled();
  });

  it('keeps a hashed asset only when the response is a complete 200 (not a failure, a 206 or an opaque one)', async () => {
    const put = vi.fn();
    const store = { match: async () => undefined, put };
    const responses = [
      { status: 200, type: 'basic', ok: true },
      { status: 404, type: 'basic', ok: false },
      { status: 206, type: 'basic', ok: true },
      { status: 200, type: 'opaque', ok: false },
    ].map((r) => ({ ...r, clone: () => r }));
    let n = 0;
    const sw = load({
      caches: { open: async () => store },
      fetch: async () => responses[n++],
    });
    for (let i = 0; i < responses.length; i++) {
      const respondWith = vi.fn();
      sw.handlers.fetch?.({
        request: { url: `https://app.example.com/assets/a${i}.js`, method: 'GET', mode: 'no-cors' },
        respondWith,
      });
      await respondWith.mock.calls[0]?.[0];
    }
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('only skips waiting when the page asks', async () => {
    const sw = load();
    sw.handlers.message?.({ data: { type: 'noop' } });
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
    sw.handlers.message?.({ data: { type: 'SKIP_WAITING' } });
    expect(sw.self.skipWaiting).toHaveBeenCalled();
  });
});
