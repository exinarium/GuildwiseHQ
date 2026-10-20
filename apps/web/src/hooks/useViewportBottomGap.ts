import { useEffect, useState } from 'react';

/**
 * How many px of the layout viewport the on-screen keyboard covers at the bottom (0 when it is closed, or the browser has
 * no visualViewport). A fixed screen with `bottom: gap` ends exactly above the keyboard, so its composer stays pinned there
 * instead of jumping when the browser scrolls the page. Small differences (URL bar) count as no keyboard.
 */
export function useViewportBottomGap(enabled = true): number {
  const [gap, setGap] = useState(0);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!enabled || !vv) {
      setGap(0);
      return;
    }
    const on = () => {
      const g = Math.round(window.innerHeight - vv.height - vv.offsetTop);
      setGap(g > 120 ? g : 0);
    };
    on();
    vv.addEventListener('resize', on);
    vv.addEventListener('scroll', on);
    return () => {
      vv.removeEventListener('resize', on);
      vv.removeEventListener('scroll', on);
    };
  }, [enabled]);
  return gap;
}
