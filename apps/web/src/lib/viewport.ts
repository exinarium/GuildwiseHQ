import { useEffect, useSyncExternalStore } from 'react';

/**
 * The one place the phone layout learns about the visible viewport and the on-screen keyboard.
 *
 * It writes CSS custom properties on <html> (no React render per event) and keeps one boolean for React:
 *   --vvh      height of the visible viewport (the app frame height)
 *   --vv-top   how far the visible viewport is panned down inside the layout viewport
 *   --kbd-gap  how much of the layout viewport the keyboard covers at the bottom (0 when closed)
 *   html[data-kbd]  set while the keyboard is open
 *
 * Started on the first subscriber, stopped on the last. Updates are coalesced with requestAnimationFrame.
 */

/** The single keyboard threshold in px: a smaller shrink is the browser's own bars, not a keyboard. */
export const KEYBOARD_MIN_PX = 150;

let subscribers = 0;
let keyboardOpen = false;
let baseH = 0;
let baseW = 0;
let frame = 0;
let pending = false;
const listeners = new Set<() => void>();

const TEXT_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

function isTextField(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return TEXT_INPUT_TYPES.has((el as HTMLInputElement).type || '');
  return (el as HTMLElement).isContentEditable === true;
}

function clear() {
  const root = document.documentElement;
  root.style.removeProperty('--vvh');
  root.style.removeProperty('--vv-top');
  root.style.removeProperty('--kbd-gap');
  delete root.dataset.kbd;
  setKeyboard(false);
}

function setKeyboard(next: boolean) {
  if (next === keyboardOpen) return;
  keyboardOpen = next;
  for (const l of listeners) l();
}

function measure() {
  const vv = window.visualViewport;
  if (!vv) {
    clear();
    return;
  }
  // A new width (rotation) starts a new baseline.
  if (window.innerWidth !== baseW) {
    baseW = window.innerWidth;
    baseH = 0;
  }
  baseH = Math.max(baseH, window.innerHeight, Math.round(vv.height));
  // Pinch-zoom is not a keyboard: ignore the visual viewport then.
  const zoomed = Math.abs(vv.scale - 1) > 0.01;
  const h = zoomed ? window.innerHeight : Math.round(vv.height);
  const top = zoomed ? 0 : Math.max(0, Math.round(vv.offsetTop));
  const kbd = !zoomed && isTextField(document.activeElement) && baseH - h > KEYBOARD_MIN_PX;
  const gap = kbd ? Math.max(0, Math.round(window.innerHeight - h - top)) : 0;
  const root = document.documentElement;
  root.style.setProperty('--vvh', `${h}px`);
  root.style.setProperty('--vv-top', `${top}px`);
  root.style.setProperty('--kbd-gap', `${gap}px`);
  if (kbd) root.dataset.kbd = '1';
  else delete root.dataset.kbd;
  setKeyboard(kbd);
}

function schedule() {
  if (pending) return;
  if (typeof requestAnimationFrame !== 'function') {
    measure();
    return;
  }
  pending = true;
  frame = requestAnimationFrame(() => {
    pending = false;
    measure();
  });
}

function start() {
  const vv = window.visualViewport;
  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', schedule);
  measure();
}

function stop() {
  const vv = window.visualViewport;
  vv?.removeEventListener('resize', schedule);
  vv?.removeEventListener('scroll', schedule);
  window.removeEventListener('resize', schedule);
  window.removeEventListener('orientationchange', schedule);
  document.removeEventListener('focusin', schedule);
  document.removeEventListener('focusout', schedule);
  if (pending && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  pending = false;
  baseH = 0;
  baseW = 0;
  clear();
}

function retain(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (subscribers++ === 0) start();
  return () => {
    if (--subscribers === 0) stop();
  };
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const release = retain();
  return () => {
    listeners.delete(cb);
    release();
  };
}

/** Keeps the viewport variables up to date while `enabled` (the phone shell). */
export function useViewportSync(enabled: boolean): void {
  useEffect(() => (enabled ? retain() : undefined), [enabled]);
}

/** True while the on-screen keyboard is open (a text field has focus and the visible viewport shrank a lot). */
export function useKeyboardOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => keyboardOpen,
    () => false,
  );
}
