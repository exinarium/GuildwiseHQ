import { useSyncExternalStore } from 'react';

/** Subscribes to a CSS media query. jsdom has no matchMedia: the server snapshot (and fallback) is `fallback`. */
export function useMediaQuery(query: string, fallback = false): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
      const mq = window.matchMedia(query);
      mq.addEventListener?.('change', cb);
      return () => mq.removeEventListener?.('change', cb);
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}

/** >= 1024. Defaults to desktop where matchMedia is unavailable (unit tests). */
export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)', true);
/** >= 768 (rail or sidebar). */
export const useIsTabletUp = () => useMediaQuery('(min-width: 768px)', true);
