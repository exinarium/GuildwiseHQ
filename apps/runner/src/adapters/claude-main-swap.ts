import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAIN_ACCOUNT } from '@aom/shared';
import type { ClaudeAccountRegistry } from './claude-accounts.ts';
import { type CredentialsDoc, readCredentials, withLock } from './claude-auth.ts';

/**
 * "Make main" for Claude Code (owner decision 2026-10-25): a named config-dir account and the main account (the machine login in
 * `~/.claude`) swap places. What moves is the model login only: the `claudeAiOauth` entry of each `.credentials.json` and the
 * `oauthAccount` entry of each `.claude.json` (the e-mail and plan shown). Plugin sign-ins (`mcpOAuth`), settings, history and
 * everything else stay where they are. Doing it again undoes it.
 *
 * Crash safety: both new files of each pair are written next to the old ones first (0600), a journal names them, then they are
 * renamed into place. A runner that stops in between finishes the renames when it starts (`recoverClaudeMainSwap`); the journal
 * holds paths only, never a secret.
 */

const JOURNAL = 'claude-main-swap.json';

export interface ClaudeSwapDeps {
  home: string;
  /** The runner data dir (the journal and the main account's lock live there). */
  root: string;
  registry: ClaudeAccountRegistry;
  /** The owner allowed web changes to the machine's own login (`integrations.machineScopeFromWeb`, primary pairing). */
  machineScopeAllowed: boolean;
  /** An agent job or a chat is running: a session holds a copy of its account's login and would write it back afterwards. */
  busy: () => boolean;
  /** How the main account authenticates: only the machine login (`default`) can be swapped. */
  mainAuthMode: () => 'oauth' | 'api_key' | 'default';
}

type Result = { ok: true } | { ok: false; error: string };

const readJson = (file: string): Record<string, unknown> | null => {
  if (!existsSync(file)) return {};
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

function writeNew(file: string, doc: unknown): string {
  const tmp = `${file}.aom-swap.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(doc)}\n`, { mode: 0o600 });
  return tmp;
}

/** The two values of one key exchanged between two documents (a missing value is removed, not set to undefined). */
function exchange<T extends Record<string, unknown>>(a: T, b: T, key: string): [T, T] {
  const na = { ...a } as Record<string, unknown>;
  const nb = { ...b } as Record<string, unknown>;
  if (Object.hasOwn(b, key)) na[key] = b[key];
  else delete na[key];
  if (Object.hasOwn(a, key)) nb[key] = a[key];
  else delete nb[key];
  return [na as T, nb as T];
}

export async function swapClaudeMain(key: string, deps: ClaudeSwapDeps): Promise<Result> {
  if (!deps.machineScopeAllowed)
    return {
      ok: false,
      error:
        'the main Claude login is the machine’s own: only the primary pairing may change it from the web (integrations.machineScopeFromWeb in config.json)',
    };
  const acct = key === MAIN_ACCOUNT ? undefined : deps.registry.get(key);
  if (!acct) return { ok: false, error: `there is no account ${key} on this workstation` };
  if (acct.source !== 'config_dir' || !acct.configDir)
    return {
      ok: false,
      error: `account ${key} is a token or key: only an account with its own sign-in folder can become the main account`,
    };
  if (deps.mainAuthMode() !== 'default')
    return {
      ok: false,
      error:
        'the main account uses a token or API key from config.json or the secrets folder, not the machine login: change it there',
    };
  if (deps.busy())
    return {
      ok: false,
      error: 'agents are working on this workstation: wait until they are done, then try again',
    };

  const mainCreds = join(deps.home, '.claude', '.credentials.json');
  const acctCreds = join(acct.configDir, '.credentials.json');
  const mainProfile = join(deps.home, '.claude.json');
  const acctProfile = join(acct.configDir, '.claude.json');
  const mainLock = join(deps.root, 'claude-credentials.lock');
  const acctLock = join(acct.configDir, '.aom-credentials.lock');

  return withLock(mainLock, () =>
    withLock(acctLock, async (): Promise<Result> => {
      const a = readCredentials(mainCreds);
      const b = readCredentials(acctCreds);
      if (!a?.claudeAiOauth || !b?.claudeAiOauth)
        return {
          ok: false,
          error:
            'both accounts must be signed in before they can swap places; sign in to the one that is not',
        };
      const pa = readJson(mainProfile);
      const pb = readJson(acctProfile);
      if (!pa || !pb) return { ok: false, error: 'a .claude.json could not be read: nothing was changed' };
      const [na, nb] = exchange<CredentialsDoc>(a, b, 'claudeAiOauth');
      const [qa, qb] = exchange(pa, pb, 'oauthAccount');
      const pairs: Array<{ tmp: string; final: string }> = [];
      try {
        for (const [final, doc] of [
          [mainCreds, na],
          [acctCreds, nb],
          [mainProfile, qa],
          [acctProfile, qb],
        ] as const)
          pairs.push({ tmp: writeNew(final, doc), final });
      } catch (err) {
        for (const p of pairs) rmSync(p.tmp, { force: true });
        return {
          ok: false,
          error: `could not prepare the swap: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const journal = join(deps.root, JOURNAL);
      writeFileSync(journal, JSON.stringify({ pairs }), { mode: 0o600 });
      for (const p of pairs) renameSync(p.tmp, p.final);
      rmSync(journal, { force: true });
      // the monitors describe a login, not a name: they follow it
      deps.registry.swapStates(MAIN_ACCOUNT, key);
      return { ok: true };
    }),
  );
}

/** At the runner's start: finishes a swap that was interrupted between the preparation and the last rename. */
export function recoverClaudeMainSwap(root: string): number {
  const journal = join(root, JOURNAL);
  if (!existsSync(journal)) return 0;
  let done = 0;
  try {
    const j = JSON.parse(readFileSync(journal, 'utf8')) as {
      pairs?: Array<{ tmp?: unknown; final?: unknown }>;
    };
    for (const p of j.pairs ?? [])
      if (
        typeof p.tmp === 'string' &&
        typeof p.final === 'string' &&
        p.tmp.endsWith('.aom-swap.tmp') &&
        existsSync(p.tmp)
      ) {
        renameSync(p.tmp, p.final);
        done++;
      }
  } catch {
    // an unreadable journal is left for the owner; the next swap overwrites it
    return 0;
  }
  rmSync(journal, { force: true });
  return done;
}
