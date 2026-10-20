import { z } from 'zod';

export const MAIN_ACCOUNT = 'main' as const;
export const ACCOUNT_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** Any account key including 'main'. */
export const AccountKeySchema = z.string().regex(ACCOUNT_KEY_RE);
/** A project / additional account key: never 'main'. */
export const ClaudeAccountKeySchema = AccountKeySchema.refine((k) => k !== MAIN_ACCOUNT, {
  message: 'reserved',
});

/** Announced in hello.capabilities by runners that understand accounts (shift.start.account, claude.account.ensure). */
export const CLAUDE_ACCOUNTS_CAPABILITY = 'claude-accounts:1';

export const ClaudeAccountLoginSchema = z.enum(['ok', 'expired', 'none']);
export const ClaudeAccountInfoSchema = z.object({
  key: AccountKeySchema,
  main: z.boolean(),
  source: z.enum(['config_dir', 'token', 'api_key', 'default']),
  /** Display only, home-relative ('~/.claude-gw-work'). Never a token. */
  configDir: z.string().max(400).optional(),
  email: z.string().max(200).optional(),
  /** oauthAccount.organizationType, e.g. 'claude_max', 'claude_team'. */
  plan: z.string().max(60).optional(),
  login: ClaudeAccountLoginSchema,
  usage: z.enum(['ok', 'limited']),
  limitedUntil: z.iso.datetime().optional(),
  limitedLabel: z.string().max(100).optional(),
  detail: z.string().max(300).optional(),
});
export type ClaudeAccountInfo = z.infer<typeof ClaudeAccountInfoSchema>;

export const ClaudeAccountEnsurePayloadSchema = z.object({
  key: ClaudeAccountKeySchema,
  /** Optional preferred dir ('~' allowed); default: the runner-owned '~/.claude-gw-<key>' (never a dir or alias the runner did not create). */
  configDir: z.string().max(400).optional(),
});
export type ClaudeAccountEnsurePayload = z.infer<typeof ClaudeAccountEnsurePayloadSchema>;
export const ClaudeAccountEnsureResultSchema = z.object({
  key: ClaudeAccountKeySchema,
  state: z.enum(['ready', 'awaiting_login', 'needs_owner', 'failed']),
  configDir: z.string().max(400).optional(), // display, home-relative
  aliasAdded: z.boolean(),
  /** Unused by this runner: provisioning never reuses an alias it did not create. */
  aliasExisting: z.string().max(300).optional(),
  aliasConflict: z.boolean().optional(),
  /** Exact commands for the owner when state is needs_owner | failed | awaiting_login. */
  detail: z.string().max(600).optional(),
});
export type ClaudeAccountEnsureResult = z.infer<typeof ClaudeAccountEnsureResultSchema>;

/** The project's account setting as the dispatcher reads it. */
export interface ProjectAccountSetting {
  accountKey: string | null;
  fallbackToMain: boolean;
}
/** The slice of a workstation runtime the resolver reads (RuntimeInfo-compatible). */
export interface AccountRuntimeView {
  available: boolean;
  auth?: 'ok' | 'expired';
  usage?: 'ok' | 'limited';
  limitedUntil?: string;
  accounts?: ClaudeAccountInfo[];
}

/**
 * Legacy top-level fields (runners without accounts[]): a limit counts only while `limitedUntil` is still ahead (a limit
 * without a time is not in force).
 */
function legacyLimitActive(usage: string | undefined, limitedUntil: string | undefined, now: Date): boolean {
  return usage === 'limited' && !!limitedUntil && Date.parse(limitedUntil) > now.getTime();
}

/** Is account `key` usable on this runtime now? Legacy runtimes (no accounts[]) only know 'main'. */
export function accountUsable(rt: AccountRuntimeView | undefined, key: string, now: Date): boolean {
  if (!rt?.available) return false;
  const entry = rt.accounts?.find((a) => a.key === key);
  // The runner is authoritative for accounts[]: it keeps an account `limited` until its own probe clears it, so a
  // `limitedUntil` in the past does not make the account usable (it would only be claimed and rejected again).
  if (entry) return entry.login === 'ok' && entry.usage !== 'limited';
  // No entry: a legacy runtime (or one that does not list main) knows only the main account.
  if (key !== MAIN_ACCOUNT) return false;
  return rt.auth !== 'expired' && !legacyLimitActive(rt.usage, rt.limitedUntil, now);
}

/** Any account usable (freeAgents gate). */
export function anyAccountUsable(rt: AccountRuntimeView | undefined, now: Date): boolean {
  if (!rt?.available) return false;
  if (accountUsable(rt, MAIN_ACCOUNT, now)) return true;
  return (rt.accounts ?? []).some((a) => accountUsable(rt, a.key, now));
}

/**
 * The account a shift runs on: the project's key, else (fallback on) 'main', else null = pause.
 * `project` null/undefined = not ticket-bound, or a project without an account: 'main' if usable, else null.
 */
export function resolveShiftAccount(
  project: ProjectAccountSetting | null | undefined,
  rt: AccountRuntimeView | undefined,
  now: Date,
): { key: string; viaFallback: boolean } | null {
  const key = project?.accountKey;
  if (key && key !== MAIN_ACCOUNT) {
    if (accountUsable(rt, key, now)) return { key, viaFallback: false };
    if (project.fallbackToMain && accountUsable(rt, MAIN_ACCOUNT, now))
      return { key: MAIN_ACCOUNT, viaFallback: true };
    return null;
  }
  return accountUsable(rt, MAIN_ACCOUNT, now) ? { key: MAIN_ACCOUNT, viaFallback: false } : null;
}
