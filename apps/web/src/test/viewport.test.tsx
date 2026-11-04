import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardOpen, useViewportSync } from '../lib/viewport.ts';

class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  scale = 1;
}

let vv: FakeViewport;
let field: HTMLTextAreaElement;
const root = document.documentElement;

function setViewport(next: Partial<Pick<FakeViewport, 'height' | 'offsetTop' | 'scale'>>) {
  Object.assign(vv, next);
  act(() => {
    vv.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  vv = new FakeViewport();
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
  // Run animation frames at once so a test sees the result of each event.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  field = document.createElement('textarea');
  document.body.append(field);
});

afterEach(() => {
  field.remove();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
});

function mount() {
  return renderHook(() => {
    useViewportSync(true);
    return useKeyboardOpen();
  });
}

describe('the viewport store', () => {
  it('writes the visible viewport to CSS variables and reports no keyboard when closed', () => {
    const { result } = mount();
    expect(root.style.getPropertyValue('--vvh')).toBe('800px');
    expect(root.style.getPropertyValue('--vv-top')).toBe('0px');
    expect(root.style.getPropertyValue('--kbd-gap')).toBe('0px');
    expect(root.dataset.kbd).toBeUndefined();
    expect(result.current).toBe(false);
  });

  it('reports the keyboard while a text field has focus and the viewport shrank a lot, and restores afterwards', () => {
    const { result } = mount();
    act(() => field.focus());
    setViewport({ height: 500 });
    expect(result.current).toBe(true);
    expect(root.dataset.kbd).toBe('1');
    expect(root.style.getPropertyValue('--vvh')).toBe('500px');
    expect(root.style.getPropertyValue('--kbd-gap')).toBe('300px');

    act(() => field.blur());
    setViewport({ height: 800 });
    expect(result.current).toBe(false);
    expect(root.dataset.kbd).toBeUndefined();
    expect(root.style.getPropertyValue('--kbd-gap')).toBe('0px');
    expect(root.style.getPropertyValue('--vvh')).toBe('800px');
  });

  it('does not call a shrink without a focused text field a keyboard', () => {
    const { result } = mount();
    setViewport({ height: 500 });
    expect(result.current).toBe(false);
    expect(root.dataset.kbd).toBeUndefined();
    expect(root.style.getPropertyValue('--vvh')).toBe('500px');
  });

  it('ignores a pinch-zoom (scale other than 1)', () => {
    const { result } = mount();
    act(() => field.focus());
    setViewport({ height: 400, scale: 2, offsetTop: 120 });
    expect(result.current).toBe(false);
    expect(root.style.getPropertyValue('--vvh')).toBe('800px');
    expect(root.style.getPropertyValue('--vv-top')).toBe('0px');
  });

  it('follows the pan of the visual viewport (iOS offsetTop)', () => {
    mount();
    act(() => field.focus());
    setViewport({ height: 500, offsetTop: 60 });
    expect(root.style.getPropertyValue('--vv-top')).toBe('60px');
    // 800 - 500 - 60 left at the bottom for the keyboard
    expect(root.style.getPropertyValue('--kbd-gap')).toBe('240px');
  });

  it('uses one threshold of 150 px', () => {
    const { result } = mount();
    act(() => field.focus());
    setViewport({ height: 651 });
    expect(result.current).toBe(false);
    setViewport({ height: 649 });
    expect(result.current).toBe(true);
  });

  it('starts a new baseline when the width changes (rotation), so no false keyboard', () => {
    const { result } = mount();
    act(() => field.focus());
    // rotate to landscape: the whole screen is now 390 tall
    (window as { innerWidth: number }).innerWidth = 844;
    (window as { innerHeight: number }).innerHeight = 390;
    setViewport({ height: 390 });
    expect(result.current).toBe(false);
    expect(root.style.getPropertyValue('--vvh')).toBe('390px');
  });

  it('clears everything when the last subscriber leaves', () => {
    const { unmount } = mount();
    act(() => field.focus());
    setViewport({ height: 500 });
    expect(root.dataset.kbd).toBe('1');
    unmount();
    expect(root.dataset.kbd).toBeUndefined();
    expect(root.style.getPropertyValue('--vvh')).toBe('');
  });

  it('does nothing without the visualViewport API', () => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
    const { result } = mount();
    expect(result.current).toBe(false);
    expect(root.style.getPropertyValue('--vvh')).toBe('');
  });
});
