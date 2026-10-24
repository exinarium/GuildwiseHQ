import { vi } from 'vitest';

/** One manifest entry the way media/build-manifest.mjs writes it (a webm, the chapters JSON and the captions). */
export const manifestEntry = (slug: string) => {
  const f = (ext: string, type: string) => ({
    path: `/videos/${slug}.${ext}`,
    sha256: `sha-${slug}-${ext}`,
    bytes: 1000,
    type,
  });
  return {
    files: { webm: f('webm', 'video/webm') },
    info: f('json', 'application/json'),
    captions: f('vtt', 'text/vtt'),
    duration: 70,
  };
};

export const manifestOf = (...slugs: string[]) => ({
  version: 1,
  hash: 'h',
  videos: Object.fromEntries(slugs.map((s) => [s, manifestEntry(s)])),
});

const jsonOk = (body: unknown) => ({ ok: true, json: async () => body });
const notJson = { ok: true, json: async () => Promise.reject(new Error('not json')) };

/**
 * Stubs `fetch` like the app server in front of the media container: the manifest lists `listed`, the chapters JSON of
 * every slug in `infos` is served (the content-addressed URL the player asks for), everything else answers with the HTML
 * fallback page. `manifest: 'down'` makes the manifest request fail like an unreachable media service.
 */
export function serveVideos(
  opts: {
    listed: string[];
    infos?: string[];
    info?: (slug: string) => unknown;
    manifest?: 'ok' | 'down' | 'html' | 'unavailable';
  },
  infoOf: (slug: string) => unknown = (slug) => ({
    title: `Video ${slug}`,
    src: `/videos/${slug}.webm`,
    type: 'video/webm',
    captions: `/videos/${slug}.vtt`,
    duration: 70,
    chapters: [
      { t: 0, title: 'First' },
      { t: 30, title: 'Second' },
    ],
  }),
) {
  const infos = opts.infos ?? opts.listed;
  const mock = vi.fn(async (url: string) => {
    const path = url.split('?')[0] as string;
    if (path === '/videos/manifest.json') {
      if (opts.manifest === 'down') throw new TypeError('network error');
      if (opts.manifest === 'unavailable') return { ok: false, json: async () => ({}) };
      if (opts.manifest === 'html') return notJson;
      return jsonOk(manifestOf(...opts.listed));
    }
    const slug = infos.find((s) => path === `/videos/${s}.json`);
    return slug ? jsonOk((opts.info ?? infoOf)(slug)) : notJson;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
