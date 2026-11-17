import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** `~/x` or `$HOME/x` to an absolute path (a relative path is taken from the home). */
export function expandHome(p: string, home: string): string {
  let q = p.trim();
  if (q === '~') return home;
  if (q.startsWith('~/') || q.startsWith('~\\')) q = join(home, q.slice(2));
  else if (q === '$HOME') q = home;
  else if (q.startsWith('$HOME/') || q.startsWith('${HOME}/')) q = join(home, q.slice(q.indexOf('/') + 1));
  return isAbsolute(q) ? resolve(q) : resolve(home, q);
}

/** A path inside the home as `~/x`, for display and the server (the real home path never leaves the machine). */
export function displayDir(abs: string, home: string): string {
  const a = resolve(abs);
  const h = resolve(home);
  if (a === h) return '~';
  return a.startsWith(`${h}/`) || a.startsWith(`${h}\\`) ? `~${a.slice(h.length).replaceAll('\\', '/')}` : a;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every occurrence of the home folder in free text as `~`, only at a path boundary (`/home/u` never eats
 * `/home/user2`). Both the given and the real home are masked: git prints real paths and the home can be a symlink.
 */
export function maskHomeIn(text: string, home: string): string {
  let realHome = home;
  try {
    realHome = realpathSync(home);
  } catch {
    // not on this disk: only the given form
  }
  const homes = new Set<string>();
  for (const h of [home, realHome]) {
    const t = h.replace(/[/\\]+$/, '');
    if (t.length > 1) homes.add(t);
  }
  let out = text;
  // Longest first, so a real home that contains the given one (or the other way round) is masked whole.
  for (const h of [...homes].sort((a, b) => b.length - a.length))
    out = out.replace(new RegExp(`${escapeRe(h)}(?=[/\\\\]|$|[^\\w.\\-])`, 'g'), '~');
  return out;
}
