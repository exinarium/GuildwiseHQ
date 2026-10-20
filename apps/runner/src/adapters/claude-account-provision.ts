import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ClaudeAccountEnsurePayload, ClaudeAccountEnsureResult } from '@aom/shared';
import { type ClaudeAccountConfig, loadConfig, type RunnerConfig, saveConfig } from '../config.ts';
import { type ClaudeAccountRegistry, displayDir, expandHome } from './claude-accounts.ts';

/**
 * Provisioning an additional Claude account on this workstation (docs/design/claude-accounts.md section 2.3, owner
 * decisions D1 and D6). Idempotent. The runner only ever uses folders and aliases it created itself: it never adopts the
 * user's own `~/.claude-work` or `claude-work` alias (the owner uses those interactively). For a key it:
 *   1. picks the folder: the config.json entry's `configDir` (the owner chose it), else the runner-owned default
 *      `~/.claude-gw-<key>`; refuses folders inside the runner data dir, inside `~/.claude` (main) or outside the home;
 *   2. creates the folder (0700) with an ownership marker file (`.aom-runner-owned`), or recognises one it created earlier;
 *      a default folder that exists WITHOUT the marker is not touched and not adopted: the answer is `failed`;
 *   3. registers `{key, configDir, source:'config_dir'}` in this pairing's config.json;
 *   4. adds the alias `claude-gw-<key>` once, inside a marked block of `~/.bashrc` (`~/.zshrc` for zsh), never touching other
 *      lines (an alias of that name outside the block is a conflict and is left alone);
 *   5. answers `ready` (a login is there) or `awaiting_login`; the login itself is the existing web linking flow.
 * Steps 2 to 4 touch the user's home, so they run only where the policy allows (the machine's primary pairing with
 * `machineScopeFromWeb: 'primary'`); otherwise the answer is `needs_owner` with the exact terminal commands.
 */

export const ALIAS_BLOCK_START = '# >>> guildwise claude accounts >>>';
export const ALIAS_BLOCK_END = '# <<< guildwise claude accounts <<<';
export const OWNER_MARKER = '.aom-runner-owned';
const ALIAS_FILES = ['.bashrc', '.bash_aliases', '.zshrc', '.profile'];

/** The runner-owned folder name and alias of a key; chosen so they cannot collide with the user's own `claude-<name>`. */
export const ownedDirName = (key: string): string => `.claude-gw-${key}`;
export const ownedAliasName = (key: string): string => `claude-gw-${key}`;

export interface ProvisionDeps {
  /** The user's real home. */
  home: string;
  /** The runner data dir. */
  root: string;
  /** This pairing's config.json. */
  configPath: string;
  /** May this process write the user's home from a web command? (primary pairing and `machineScopeFromWeb: 'primary'`) */
  machineScopeAllowed: boolean;
  registry: ClaudeAccountRegistry;
  /** Probes the account's login (updates its state). */
  probeLogin: (key: string) => Promise<'ok' | 'expired' | 'unknown'>;
  /** Called after the account was registered (the runner reports the new account). */
  afterRegister?: () => void | Promise<void>;
  platform?: NodeJS.Platform;
  /** `$SHELL`, to choose between `~/.bashrc` and `~/.zshrc`. */
  shell?: string;
}

export interface FoundAlias {
  file: string;
  name: string;
  body: string;
  /** The folder in `CLAUDE_CONFIG_DIR=<dir> claude`, absolute; undefined when the alias does not have that shape. */
  dir?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A shell alias by name in the shell files, if any (read only; used to detect a conflict, never to adopt). */
export function findAlias(key: string, home: string, files: string[] = ALIAS_FILES): FoundAlias | undefined {
  const re = new RegExp(`^\\s*alias\\s+${escapeRe(key)}=(['"]?)(.*)\\1\\s*$`);
  for (const f of files) {
    const file = join(home, f);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const m = re.exec(line.replace(/\r$/, ''));
      if (!m) continue;
      const body = m[2] as string;
      const d = /CLAUDE_CONFIG_DIR=("[^"]*"|'[^']*'|\S+)\s+claude\b/.exec(body);
      const raw = d?.[1]?.replace(/^["']|["']$/g, '');
      return { file, name: key, body, ...(raw ? { dir: expandHome(raw, home) } : {}) };
    }
  }
  return undefined;
}

/** Does the marked block of `file` hold the alias we wrote for `key`? */
export function blockHasAlias(file: string, key: string): boolean {
  try {
    const text = readFileSync(file, 'utf8');
    const i = text.indexOf(ALIAS_BLOCK_START);
    const j = i >= 0 ? text.indexOf(ALIAS_BLOCK_END, i) : -1;
    return i >= 0 && j >= 0 && text.slice(i, j).includes(`alias ${ownedAliasName(key)}=`);
  } catch {
    return false;
  }
}

/** Is `dir` acceptable as an account folder? Says why not. */
export function checkAccountDir(dir: string, home: string, root: string): string | undefined {
  const d = resolve(dir);
  const inside = (parent: string, child: string) => {
    const r = relative(resolve(parent), child);
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
  };
  if (!inside(home, d) || d === resolve(home))
    return 'the folder must be inside your home directory (and not the home itself)';
  if (inside(root, d)) return 'the folder must not be inside the runner data folder';
  if (inside(join(home, '.claude'), d)) return '~/.claude is the main account; pick another folder';
  return undefined;
}

const aliasLine = (key: string, dirDisplay: string) =>
  `alias ${ownedAliasName(key)}='CLAUDE_CONFIG_DIR=${dirDisplay} claude'`;

/** The text of a shell file with `key`'s alias inside the marked block (the block is created once; keys are sorted). */
export function withAliasBlock(text: string, key: string, dirDisplay: string): string {
  const startIdx = text.indexOf(ALIAS_BLOCK_START);
  const endIdx = startIdx >= 0 ? text.indexOf(ALIAS_BLOCK_END, startIdx) : -1;
  const own = /^alias claude-gw-([a-z][a-z0-9-]*)='.*'$/;
  const entries = new Map<string, string>();
  let before = text;
  let after = '';
  if (startIdx >= 0 && endIdx >= 0) {
    const inner = text.slice(startIdx + ALIAS_BLOCK_START.length, endIdx);
    for (const l of inner.split('\n')) {
      const m = own.exec(l.trim());
      if (m) entries.set(m[1] as string, l.trim());
    }
    before = text.slice(0, startIdx);
    after = text.slice(endIdx + ALIAS_BLOCK_END.length);
  }
  if (!entries.has(key)) entries.set(key, aliasLine(key, dirDisplay));
  const block = [
    ALIAS_BLOCK_START,
    ...[...entries.keys()].sort().map((k) => entries.get(k)),
    ALIAS_BLOCK_END,
  ].join('\n');
  if (startIdx >= 0 && endIdx >= 0) return `${before}${block}${after}`;
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  return `${text}${sep}${text.length === 0 ? '' : '\n'}${block}\n`;
}

function writeAtomic(file: string, body: string, fallbackMode = 0o644): void {
  let mode = fallbackMode;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    // new file
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode });
  renameSync(tmp, file);
}

/** Adds the alias inside the marked block of the shell rc file. Returns the file written, or undefined when nothing changed. */
export function addAlias(
  key: string,
  dirDisplay: string,
  home: string,
  shell: string | undefined,
): string | undefined {
  const rc = join(home, shell?.endsWith('zsh') ? '.zshrc' : '.bashrc');
  let text = '';
  try {
    text = readFileSync(rc, 'utf8');
  } catch {
    // created below
  }
  const next = withAliasBlock(text, key, dirDisplay);
  if (next === text) return undefined;
  writeAtomic(rc, next);
  return rc;
}

/** Registers the account in this pairing's config.json (an existing entry for the key is kept). */
export function registerAccount(configPath: string, entry: ClaudeAccountConfig): boolean {
  const cfg = loadConfig(configPath);
  const cc = cfg.runtimes['claude-code'];
  if (cc.accounts.some((a) => a.key === entry.key)) return false;
  const next: RunnerConfig = {
    ...cfg,
    runtimes: { ...cfg.runtimes, 'claude-code': { ...cc, accounts: [...cc.accounts, entry] } },
  };
  saveConfig(configPath, next);
  return true;
}

/** Switches an existing account to another source (a token is the secondary one); the folder on disk is untouched. */
export function setAccountSource(configPath: string, key: string, source: 'config_dir' | 'token'): boolean {
  const cfg = loadConfig(configPath);
  const cc = cfg.runtimes['claude-code'];
  if (!cc.accounts.some((a) => a.key === key && a.source !== source)) return false;
  saveConfig(configPath, {
    ...cfg,
    runtimes: {
      ...cfg.runtimes,
      'claude-code': { ...cc, accounts: cc.accounts.map((a) => (a.key === key ? { ...a, source } : a)) },
    },
  });
  return true;
}

/** Unregisters the account (never deletes the folder or the alias). */
export function unregisterAccount(configPath: string, key: string): boolean {
  const cfg = loadConfig(configPath);
  const cc = cfg.runtimes['claude-code'];
  if (!cc.accounts.some((a) => a.key === key)) return false;
  saveConfig(configPath, {
    ...cfg,
    runtimes: {
      ...cfg.runtimes,
      'claude-code': { ...cc, accounts: cc.accounts.filter((a) => a.key !== key) },
    },
  });
  return true;
}

const ownerCommands = (key: string) =>
  `aom-runner accounts add ${key}, then aom-runner accounts login ${key}`;

/** Handles `claude.account.ensure`. Never throws for an expected problem: the result says what to do. */
export async function ensureClaudeAccount(
  payload: ClaudeAccountEnsurePayload,
  deps: ProvisionDeps,
): Promise<ClaudeAccountEnsureResult> {
  const { key } = payload;
  const { home, root } = deps;
  const posix = (deps.platform ?? process.platform) !== 'win32';
  const result = (r: Omit<ClaudeAccountEnsureResult, 'key'>): ClaudeAccountEnsureResult => ({ key, ...r });

  // an alias of our name that is not ours (outside the marked block) is left alone
  const found = posix ? findAlias(ownedAliasName(key), home) : undefined;
  const ours = found !== undefined && blockHasAlias(found.file, key);
  const aliasConflict = found !== undefined && !ours;
  const aliasExisting = ours ? `${ownedAliasName(key)} -> ${found?.body.slice(0, 120)}` : undefined;

  // 1. the folder: the owner's explicit config entry, else the runner-owned default
  const cfg = loadConfig(deps.configPath);
  const entry = cfg.runtimes['claude-code'].accounts.find((a) => a.key === key);
  const explicit = entry?.configDir;
  const dir = expandHome(explicit ?? payload.configDir ?? `~/${ownedDirName(key)}`, home);
  const bad = checkAccountDir(dir, home, root);
  if (bad)
    return result({
      state: 'failed',
      aliasAdded: false,
      ...(aliasConflict ? { aliasConflict } : {}),
      detail: `Account folder refused: ${bad}.`.slice(0, 600),
    });
  const shown = displayDir(dir, home);
  // 2. a folder that exists is used only when the owner chose it in config.json or the runner created it (marker)
  if (!explicit && existsSync(dir) && !existsSync(join(dir, OWNER_MARKER)))
    return result({
      state: 'failed',
      configDir: shown,
      aliasAdded: false,
      ...(aliasConflict ? { aliasConflict } : {}),
      detail:
        `${shown} already exists and was not created by Guildwise, so it was left alone. Sign in there yourself, or register it on purpose: aom-runner accounts add ${key} --config-dir ${shown}`.slice(
          0,
          600,
        ),
    });

  // 3 and 4 write the user's home: only where the policy allows
  const needsWrite = !entry || !existsSync(dir);
  if (needsWrite && !deps.machineScopeAllowed)
    return result({
      state: 'needs_owner',
      configDir: shown,
      aliasAdded: false,
      ...(aliasExisting ? { aliasExisting } : {}),
      ...(aliasConflict ? { aliasConflict } : {}),
      detail:
        `This workstation does not let the web change your home folder. On it run: ${ownerCommands(key)}`.slice(
          0,
          600,
        ),
    });
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(dir, 0o700);
      } catch {
        // not supported everywhere
      }
      if (!explicit)
        writeFileSync(join(dir, OWNER_MARKER), `created by the Guildwise runner for account ${key}\n`, {
          mode: 0o600,
        });
    }
    if (!entry) registerAccount(deps.configPath, { key, configDir: shown, source: 'config_dir' });
    let aliasAdded = false;
    if (posix && !found && deps.machineScopeAllowed)
      aliasAdded = addAlias(key, shown, home, deps.shell ?? process.env.SHELL) !== undefined;

    // 5. the login state
    deps.registry.refresh();
    const account = deps.registry.get(key);
    await deps.afterRegister?.();
    const terminal = `${ownedAliasName(key)} then /login (or CLAUDE_CONFIG_DIR=${shown} claude auth login)`;
    let state: ClaudeAccountEnsureResult['state'] = 'awaiting_login';
    if (account?.hasLogin()) {
      const p = await deps.probeLogin(key);
      state = p === 'expired' ? 'awaiting_login' : 'ready';
    }
    return result({
      state,
      configDir: shown,
      aliasAdded,
      ...(aliasExisting ? { aliasExisting } : {}),
      ...(aliasConflict ? { aliasConflict } : {}),
      ...(state === 'awaiting_login'
        ? {
            detail:
              `Sign in from the browser (Integrations, Claude Code, account ${key}), or on the workstation: ${terminal}`.slice(
                0,
                600,
              ),
          }
        : {}),
    });
  } catch (err) {
    return result({
      state: 'failed',
      configDir: shown,
      aliasAdded: false,
      ...(aliasExisting ? { aliasExisting } : {}),
      detail:
        `Could not set the account up: ${err instanceof Error ? err.message : String(err)}. On the workstation run: ${ownerCommands(key)}`.slice(
          0,
          600,
        ),
    });
  }
}
