import { useEffect, useState } from 'react';

/**
 * The height of the visual viewport in px (it shrinks when the iOS keyboard opens, unlike `100dvh`), or null when
 * the browser has no visualViewport. Used by full-height mobile screens with a composer at the bottom.
 */
export function useVisualViewportHeight(enabled = true): number | null {
  const [h, setH] = useState<number | null>(null);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!enabled || !vv) {
      setH(null);
      return;
    }
    const on = () => setH(Math.round(vv.height));
    on();
    vv.addEventListener('resize', on);
    vv.addEventListener('scroll', on);
    return () => {
      vv.removeEventListener('resize', on);
      vv.removeEventListener('scroll', on);
    };
  }, [enabled]);
  return h;
}
