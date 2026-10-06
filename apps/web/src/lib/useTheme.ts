import { useCallback, useEffect, useState } from 'react';
import { BRAND } from '../brand.ts';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = `${BRAND.storagePrefix}-theme`;

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function apply(choice: ThemeChoice): void {
  const dark =
    choice === 'dark' ||
    (choice === 'system' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/** The user's theme choice: persisted (guildwise-theme), applied to <html data-theme>, follows the OS for `system`. */
export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(read);
  useEffect(() => {
    if (choice !== 'system' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => apply('system');
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [choice]);
  const set = useCallback((c: ThemeChoice) => {
    try {
      if (c === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, c);
    } catch {
      /* storage blocked: the choice still applies for this page */
    }
    apply(c);
    setChoice(c);
  }, []);
  return [choice, set];
}
