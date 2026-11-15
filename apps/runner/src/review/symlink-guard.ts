import {
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

export interface NeutralisedLink {
  /** Path in the checkout, relative to its root, with '/' separators. */
  path: string;
  /** The link text as the PR wrote it (readlink), never the target's content. */
  linkText: string;
}

/** The fs calls the guard makes. None of them follows a link. */
export interface LinkOps {
  lstat: (p: string) => Stats;
  readdir: (p: string) => string[];
  readlink: (p: string) => string;
  /** Removes the link itself. */
  unlink: (p: string) => void;
  /** Creates a new file; fails when anything (a link included) is already at the path. */
  writePlaceholder: (p: string, text: string) => void;
}

export const nodeLinkOps: LinkOps = {
  lstat: (p) => lstatSync(p),
  readdir: (p) => readdirSync(p),
  readlink: (p) => readlinkSync(p),
  unlink: (p) => unlinkSync(p),
  writePlaceholder: (p, text) => writeFileSync(p, text, { flag: 'wx', mode: 0o444 }),
};

/** Linux MAXSYMLINKS; macOS allows 32. Either way, more hops than this is a loop. */
const MAX_HOPS = 40;

const code = (e: unknown): string => String((e as { code?: unknown } | null)?.code ?? '');

const note = (linkText: string): string =>
  `symlink to ${JSON.stringify(linkText.slice(0, 300))} removed by the review checkout: its target is outside the checkout\n`;

const parts = (text: string): string[] => text.split('/').filter(Boolean);

/**
 * Does following the link at `link` end at a location inside `realRoot` (existing or not)? Follows the kernel's
 * rules one path part at a time with `lstat` and `readlink` only, so chains and dangling links are judged by where
 * they would lead, not by their text.
 */
function resolvesInside(realRoot: string, link: string, ops: LinkOps): boolean {
  let hops = 1;
  const text = ops.readlink(link);
  let cur = isAbsolute(text) ? sep : dirname(link);
  let rest = parts(text);
  let missing = false;
  while (rest.length) {
    const c = rest.shift() as string;
    if (c === '.') continue;
    if (c === '..') {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, c);
    if (missing) {
      cur = next;
      continue;
    }
    let st: Stats;
    try {
      st = ops.lstat(next);
    } catch (e) {
      if (code(e) === 'ENOENT' || code(e) === 'ENOTDIR') {
        missing = true;
        cur = next;
        continue;
      }
      throw e;
    }
    if (st.isSymbolicLink()) {
      if (++hops > MAX_HOPS) return false;
      const t = ops.readlink(next);
      rest = [...parts(t), ...rest];
      if (isAbsolute(t)) cur = sep;
      continue;
    }
    cur = next;
    if (!st.isDirectory() && rest.length) missing = true;
  }
  return cur === realRoot || cur.startsWith(realRoot + sep);
}

const rel = (realRoot: string, p: string): string => relative(realRoot, p).split(sep).join('/');

const fail = (realRoot: string, p: string, err: unknown): Error =>
  new Error(`${code(err) || 'error'} at ${JSON.stringify(rel(realRoot, p).slice(0, 150))}`);

/**
 * Replaces every symlink of the checkout whose target resolves outside it with a read-only placeholder file. In-tree
 * links are kept. Never reads, writes or lists through a link. Throws on any error: no partial result is returned.
 */
export function neutraliseOutsideSymlinks(root: string, ops: LinkOps = nodeLinkOps): NeutralisedLink[] {
  const realRoot = realpathSync(root);
  const links: string[] = [];
  const stack = [realRoot];
  while (stack.length) {
    const dir = stack.pop() as string;
    let names: string[];
    try {
      names = ops.readdir(dir);
    } catch (e) {
      throw fail(realRoot, dir, e);
    }
    for (const name of names) {
      if (dir === realRoot && name === '.git') continue;
      const p = join(dir, name);
      let st: Stats;
      try {
        st = ops.lstat(p);
      } catch (e) {
        throw fail(realRoot, p, e);
      }
      if (st.isSymbolicLink()) links.push(p);
      else if (st.isDirectory()) stack.push(p);
    }
  }
  const kept: string[] = [];
  const done: NeutralisedLink[] = [];
  for (const l of links) {
    try {
      if (resolvesInside(realRoot, l, ops)) {
        kept.push(l);
        continue;
      }
      const linkText = ops.readlink(l);
      ops.unlink(l);
      ops.writePlaceholder(l, note(linkText));
      done.push({ path: rel(realRoot, l), linkText });
    } catch (e) {
      throw fail(realRoot, l, e);
    }
  }
  for (const l of kept) {
    let inside: boolean;
    try {
      inside = resolvesInside(realRoot, l, ops);
    } catch (e) {
      throw fail(realRoot, l, e);
    }
    if (!inside) throw fail(realRoot, l, { code: 'ELEAK' });
  }
  return done.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
