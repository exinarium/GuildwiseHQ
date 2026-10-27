import { z } from 'zod';

/**
 * Validation for owner-controlled strings that end up in other users' runners (git refs, remote URLs, vault
 * folders) and for URLs that end up as links. The runner re-applies the same checks before it touches git or the
 * filesystem; these are the single definitions both sides use.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

/** `git check-ref-format` rules for a branch name, plus no leading `-` (would parse as an option). */
export function isSafeGitRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > 200) return false;
  if (ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.')) return false;
  if (CONTROL.test(ref) || /[\s~^:?*[\\]/.test(ref)) return false;
  if (ref.includes('..') || ref.includes('@{') || ref.includes('//') || ref === '@') return false;
  return ref.split('/').every((c) => c !== '' && !c.startsWith('.') && !c.endsWith('.lock'));
}

/** A branch prefix such as `guildwise/` (or empty): `<prefix>x` must be a valid ref. */
export function isSafeBranchPrefix(prefix: string): boolean {
  return prefix === '' || isSafeGitRef(`${prefix}x`);
}

/**
 * The prefix of the branch a pull request is pushed under (`pieter` gives `pieter/DCPL-4276`): empty (use the default)
 * or a ref component path without spaces and without leading or trailing slash, 40 characters at most.
 */
export function isSafePrBranchPrefix(prefix: string): boolean {
  return (
    prefix === '' ||
    (prefix.length <= 40 &&
      !prefix.startsWith('/') &&
      !prefix.endsWith('/') &&
      /^[A-Za-z0-9._/-]+$/.test(prefix) &&
      isSafeGitRef(`${prefix}/X-1`))
  );
}

/** Used when a project sets no pull request branch prefix: no product name in the repository. */
export const DEFAULT_PR_BRANCH_PREFIX = 'feature';

/** `projects/<folder>` or a plain folder inside a vault: relative, forward slashes, no `.`/`..`/`.git` segments. */
export function isSafeVaultFolder(folder: string): boolean {
  if (folder.length === 0 || folder.length > 200) return false;
  if (CONTROL.test(folder) || folder.includes('\\') || folder.startsWith('/') || /^[a-zA-Z]:/.test(folder))
    return false;
  return folder
    .replace(/\/+$/, '')
    .split('/')
    .every((p) => p !== '' && p !== '.' && p !== '..' && p.toLowerCase() !== '.git');
}

export type RemoteUrlKind = 'https' | 'ssh' | 'local';

/**
 * Classifies a git remote the server or a manager supplies. `https://host/path`, `ssh://[user@]host/path` and
 * scp-style `git@host:path` are remotes; `file://` and absolute paths are `local` (only for tests: callers decide).
 * Anything with a password, an `http(s)` user name (tokens are often sent as the user), a leading `-`, control
 * characters or an exotic transport (`ext::`, `fd::`) is an error.
 */
export function parseRemoteUrl(
  raw: string,
): { ok: true; kind: RemoteUrlKind } | { ok: false; reason: string } {
  const url = raw.trim();
  const bad = (reason: string) => ({ ok: false as const, reason });
  if (!url) return bad('the URL is empty');
  if (url.startsWith('-')) return bad('the URL must not start with "-"');
  if (CONTROL.test(url) || /\s/.test(url))
    return bad('the URL must not contain spaces or control characters');
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  if (scheme === 'https' || scheme === 'ssh') {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return bad('not a valid URL');
    }
    if (!u.hostname) return bad('the URL has no host');
    if (u.password) return bad('credentials in the URL are not allowed; use SSH keys or a credential helper');
    if (scheme === 'https' && u.username)
      return bad('credentials in the URL are not allowed; use SSH keys or a credential helper');
    return { ok: true, kind: scheme };
  }
  if (scheme === 'file')
    return url.length > 'file://'.length ? { ok: true, kind: 'local' } : bad('empty path');
  if (scheme) return bad(`unsupported URL scheme "${scheme}" (use https, ssh or git@host:path)`);
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)\S+$/.test(url)) return { ok: true, kind: 'ssh' };
  if (/^[A-Za-z0-9._-]+:[^/]*:/.test(url) && !/^[A-Za-z]:[\\/]/.test(url))
    return bad('unsupported remote syntax');
  if (url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(url)) return { ok: true, kind: 'local' };
  return bad('use https://host/path, ssh://host/path or git@host:path');
}

/** The error message for a bad remote, or null. `allowLocal` admits `file://` and absolute paths (tests only). */
export function remoteUrlError(url: string, allowLocal: boolean): string | null {
  const r = parseRemoteUrl(url);
  if (!r.ok) return r.reason;
  if (r.kind === 'local' && !allowLocal) return 'local paths and file:// remotes are not allowed';
  return null;
}

/** Strips a password (and an http(s) user name) from a stored URL; used by the migration-safe scrub. */
export function scrubRemoteUrl(url: string): string {
  return url
    .replace(/^(https?:\/\/)[^/@\s]*@/i, '$1')
    .replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/@:\s]*):[^/@\s]*@/, '$1@');
}

/** Structural remote check for API bodies; local remotes pass here and are refused by the server config. */
export const RemoteUrlSchema = z.string().superRefine((v, ctx) => {
  const r = parseRemoteUrl(v);
  if (!r.ok) ctx.addIssue({ code: 'custom', message: r.reason });
});

export const GitRefSchema = z.string().refine(isSafeGitRef, { message: 'not a valid git branch name' });
export const BranchPrefixSchema = z
  .string()
  .refine(isSafeBranchPrefix, { message: 'not a valid branch prefix (for example "guildwise/")' });
export const PrBranchPrefixSchema = z.string().refine(isSafePrBranchPrefix, {
  message:
    'not a valid branch prefix (letters, digits, . _ - and /, at most 40 characters, for example "pieter")',
});
export const VaultFolderSchema = z
  .string()
  .refine(isSafeVaultFolder, { message: 'must be a relative folder without ".." segments' });

/** Only http(s) links are rendered or stored as links (a `javascript:` URL in an href is script execution). */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname;
  } catch {
    return false;
  }
}
export const HttpUrlSchema = z.string().refine(isHttpUrl, { message: 'must be an http(s) URL' });

/**
 * A project path: the sub directory of a repository the project lives in (`src/app`). Relative, forward slashes, no
 * `..`/`.git` segments, not absolute. Empty, `.` and `./` mean the repository root.
 */
export function isSafeProjectPath(path: string): boolean {
  const p = path.trim();
  if (p === '' || p === '.' || p === './') return true;
  if (p.length > 200 || CONTROL.test(p) || p.includes('\\') || p.startsWith('/') || /^[a-zA-Z]:/.test(p))
    return false;
  if (p.startsWith('~')) return false;
  return p
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .every((s) => s !== '' && s !== '.' && s !== '..' && s.toLowerCase() !== '.git');
}

/** The canonical form of a valid project path (`./src/app/` becomes `src/app`); `null` for the repository root. */
export function normalizeProjectPath(path: string | null | undefined): string | null {
  const p = (path ?? '').trim();
  if (!isSafeProjectPath(p)) throw new Error('not a valid project path');
  const n = p
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')
    .replace(/^\.$/, '');
  return n === '' ? null : n;
}

export const ProjectPathSchema = z.string().refine(isSafeProjectPath, {
  message: 'must be a relative sub directory without ".." segments (leave empty for the repository root)',
});
