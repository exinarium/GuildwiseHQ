import type { AvatarStyle } from '@aom/shared';
import { useSyncExternalStore } from 'react';

/**
 * Generated cartoon faces, rendered here in the browser from a seed with DiceBear (no network, no CDN). The library
 * and each style are separate chunks, loaded on first use (`loadFaceStyle`). Until a style has loaded `faceUri`
 * returns null and the caller shows initials. Only CC0 illustrated styles are bundled (see `AVATAR_STYLES`).
 */
type Core = typeof import('@dicebear/core');
type Style = Parameters<Core['createAvatar']>[0];

const loaders: Record<AvatarStyle, () => Promise<Style>> = {
  notionists: () => import('@dicebear/notionists') as unknown as Promise<Style>,
  lorelei: () => import('@dicebear/lorelei') as unknown as Promise<Style>,
  'open-peeps': () => import('@dicebear/open-peeps') as unknown as Promise<Style>,
};

/** Soft backgrounds, picked by the seed itself, so a face looks the same everywhere it appears. */
const BACKGROUNDS = ['b6e3f4', 'c0aede', 'd1d4f9', 'ffd5dc', 'ffdfbf', 'd5f0c8', 'fff1a8'];

let core: Core | null = null;
const styles = new Map<AvatarStyle, Style>();
const loading = new Map<AvatarStyle, Promise<void>>();
const uris = new Map<string, string>();
let version = 0;
const listeners = new Set<() => void>();

export function loadFaceStyle(style: AvatarStyle): Promise<void> {
  if (styles.has(style)) return Promise.resolve();
  let p = loading.get(style);
  if (!p) {
    p = Promise.all([import('@dicebear/core'), loaders[style]()]).then(
      ([c, mod]) => {
        core = c;
        styles.set(style, mod);
        version++;
        for (const l of listeners) l();
      },
      () => {
        loading.delete(style); // a later render tries again
      },
    );
    loading.set(style, p);
  }
  return p;
}

/** The face as a `data:` URI, or null while its style is still loading (that starts now). */
export function faceUri(seed: string, style: AvatarStyle): string | null {
  const key = `${style}\u0000${seed}`;
  const hit = uris.get(key);
  if (hit) return hit;
  const def = styles.get(style);
  if (!def || !core) {
    void loadFaceStyle(style);
    return null;
  }
  const uri = core
    .createAvatar(def, { seed, backgroundColor: BACKGROUNDS, backgroundType: ['solid'], radius: 0 })
    .toDataUri();
  uris.set(key, uri);
  return uri;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The face for a seed and style; re-renders when its style finishes loading. */
export function useFaceUri(seed: string | undefined, style: AvatarStyle): string | null {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  return seed ? faceUri(seed, style) : null;
}

/** Warms a style at start-up so the first faces appear without a flash of initials. */
export const preloadFaces = (style: AvatarStyle = 'notionists'): Promise<void> => loadFaceStyle(style);
