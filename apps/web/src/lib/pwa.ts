import { useSyncExternalStore } from 'react';

/** Running as an installed app (home-screen icon), not in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || !!window.matchMedia?.('(display-mode: standalone)').matches;
}

/** iPhone, iPad (also an iPad that says it is a Mac) and iPod: iOS only allows Web Push in an installed web app (16.4+). */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1)
  );
}

// ---- service worker registration and the "update available" state

let waiting: ServiceWorker | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** A new service worker is installed and waiting for the page to let it take over. */
export const useUpdateAvailable = (): boolean =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => waiting !== null,
    () => false,
  );

/** Tells the waiting worker to take over; the page reloads once it controls it. */
export function applyUpdate(): void {
  waiting?.postMessage({ type: 'SKIP_WAITING' });
}

/** The real service worker runs in production builds and secure contexts only (dev and tests use the MSW worker). */
export function shouldRegisterServiceWorker(): boolean {
  return (
    import.meta.env.PROD &&
    import.meta.env.VITE_MSW !== '1' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    window.isSecureContext
  );
}

export function registerServiceWorker(): void {
  if (!shouldRegisterServiceWorker()) return;
  const sw = navigator.serviceWorker;
  const track = (reg: ServiceWorkerRegistration) => {
    const note = (w: ServiceWorker | null) => {
      // Only an update counts: the first install has no controller yet.
      if (w && sw.controller) {
        waiting = w;
        emit();
      }
    };
    note(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed') note(w);
      });
    });
    // Look for a new version when the app comes back to the foreground (a phone keeps it alive for days).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void reg.update().catch(() => undefined);
    });
  };
  let reloading = false;
  sw.addEventListener('controllerchange', () => {
    if (reloading || !waiting) return;
    reloading = true;
    window.location.reload();
  });
  const start = () =>
    void sw
      .register('/sw.js', { scope: '/' })
      .then(track)
      .catch(() => undefined);
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

/** The number on the home-screen icon (where the browser supports it). */
export function setAppBadge(count: number): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) void nav.setAppBadge?.(count)?.catch(() => undefined);
    else void nav.clearAppBadge?.()?.catch(() => undefined);
  } catch {
    /* unsupported */
  }
}
