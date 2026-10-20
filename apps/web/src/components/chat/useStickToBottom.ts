import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** True when the scroller is within `threshold` px of its bottom. */
export function isNearBottom(
  el: { scrollTop: number; clientHeight: number; scrollHeight: number },
  threshold = 80,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

/**
 * Keeps a log scrolled to the bottom only while the reader is already near it. When content grows while they have
 * scrolled up it does nothing and reports `unseen` (drives the "Jump to latest" pill). `contentKey` changes whenever
 * the content does; `force()` sticks again (the user sent a message).
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, contentKey: unknown) {
  const stick = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const [away, setAway] = useState(false);

  const toBottom = useCallback(
    (smooth = false) => {
      const el = ref.current;
      if (!el) return;
      if (smooth && typeof el.scrollTo === 'function')
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      else el.scrollTop = el.scrollHeight;
      stick.current = true;
      setUnseen(false);
      setAway(false);
    },
    [ref],
  );

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const near = isNearBottom(el);
    stick.current = near;
    setAway(!near);
    if (near) setUnseen(false);
  }, [ref]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the content changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setUnseen(true);
  }, [contentKey]);

  // Fonts, images and a closing keyboard change the height without a content change.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return { onScroll, unseen, away, toBottom, force: () => (stick.current = true) };
}
