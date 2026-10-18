import { del, post } from '../api/client.ts';
import { isIos, isStandalone } from './pwa.ts';

export type PushSupport =
  /** iPhone or iPad in a browser tab: Add to Home Screen first. */
  | 'needs-install'
  | 'unsupported'
  /** Permission was refused: only the browser's settings can change it. */
  | 'denied'
  | 'ready';

/** Whether this browser can take Web Push right now, in the order the UI explains it. */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (isIos() && !isStandalone()) return 'needs-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
    return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ready';
}

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob((base64Url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The service worker of this page (absent in dev and tests: the real one is registered by production builds only). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration('/')) ?? null;
}

export async function currentEndpoint(): Promise<string | null> {
  try {
    const reg = await registration();
    return (await reg?.pushManager.getSubscription())?.endpoint ?? null;
  } catch {
    return null;
  }
}

/** Asks for permission (call it from a tap), subscribes this browser and registers it with the server. */
export async function enablePush(publicKey: string): Promise<{ id: string }> {
  const reg = await registration();
  if (!reg) throw new Error('The app is not installed as a service worker here. Use the production site.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    throw new Error('Notifications were not allowed. Change it in the browser settings.');
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth)
    throw new Error('The browser returned no push keys.');
  return post<{ id: string }>('/push/subscriptions', {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
}

/** Removes a device from the server; when it is this browser's own subscription, unsubscribes it too. */
export async function removeDevice(id: string, endpoint: string): Promise<void> {
  await del(`/push/subscriptions/${id}`);
  try {
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub && sub.endpoint === endpoint) await sub.unsubscribe();
  } catch {
    /* the server side is already gone */
  }
}
