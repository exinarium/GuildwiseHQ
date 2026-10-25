import { useEffect, useRef } from 'react';

/** The keyboard shortcuts of the app (also listed in the `?` dialog). */
export const SHORTCUTS: Array<{ keys: string[]; label: string; group: 'General' | 'Go to' | 'Create' }> = [
  { group: 'General', keys: ['Ctrl', 'K'], label: 'Open the command palette (⌘ K on a Mac)' },
  { group: 'General', keys: ['/'], label: 'Search cards (focus the board search, or open the palette)' },
  { group: 'General', keys: ['?'], label: 'Show this list' },
  { group: 'Go to', keys: ['g', 'b'], label: 'Board' },
  { group: 'Go to', keys: ['g', 'd'], label: 'Your desk' },
  { group: 'Go to', keys: ['g', 'a'], label: 'Agents' },
  { group: 'Go to', keys: ['g', 'p'], label: 'Projects' },
  { group: 'Go to', keys: ['g', 'w'], label: 'Workstations' },
  { group: 'Go to', keys: ['g', 'i'], label: 'Interests' },
  { group: 'Create', keys: ['n'], label: 'New card' },
];

/** Key chords: after `g`, the next key within this long picks the page. */
const CHORD_MS = 1500;

const typing = (t: EventTarget | null): boolean => {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
};

export interface ShortcutHandlers {
  palette: () => void;
  help: () => void;
  go: (page: 'board' | 'desk' | 'agents' | 'projects' | 'workstations' | 'interests') => void;
  newCard: () => void;
  search: () => void;
}

/**
 * Global shortcuts. Ctrl/Cmd+K works everywhere (also while typing); the single keys and `g` chords are ignored in
 * fields, with a modifier held and while a dialog is open.
 */
export function useGlobalShortcuts(h: ShortcutHandlers): void {
  const handlers = useRef(h);
  handlers.current = h;
  useEffect(() => {
    let chord = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        handlers.current.palette();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || typing(e.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const now = Date.now();
      if (chord && now - chord < CHORD_MS) {
        chord = 0;
        const page = (
          { b: 'board', d: 'desk', a: 'agents', p: 'projects', w: 'workstations', i: 'interests' } as const
        )[e.key.toLowerCase() as 'b'];
        if (page) {
          e.preventDefault();
          handlers.current.go(page);
        }
        return;
      }
      chord = 0;
      if (e.key === 'g') chord = now;
      else if (e.key === 'n') {
        e.preventDefault();
        handlers.current.newCard();
      } else if (e.key === '/') {
        e.preventDefault();
        handlers.current.search();
      } else if (e.key === '?') {
        e.preventDefault();
        handlers.current.help();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
