import { z } from 'zod';
import {
  AccountKeySchema,
  type AccountRuntimeView,
  accountUsable,
  type ClaudeAccountInfoSchema,
  isReservedAccountName,
  MAIN_ACCOUNT,
  type ProjectAccountSetting,
  resolveShiftAccount,
} from '../claude/accounts.ts';
import { BACKEND_IDS, splitBackendModel } from '../models/backends.ts';
import { type KeyUseReport, keyAccountUsable, ORG_ACCOUNT } from '../models/credentials.ts';
import {
  DIRECT_PROVIDER_IDS,
  DIRECT_RUNTIME,
  type ProviderKeyId,
  ProviderKeyIdSchema,
  splitDirectModel,
} from '../models/direct.ts';
import { CODEX_RUNTIME, GEMINI_RUNTIME, OPENCODE_RUNTIME } from '../models/runtimes.ts';

/**
 * Accounts per provider and runtime (docs/design/discovery-boardroom-registry.md, "S-A as built"). Claude Code accounts
 * (docs/design/claude-accounts.md) are the pattern, generalised along two lines:
 *
 *  - **login accounts** (`claude-code`, `codex`, `gemini`): a CLI's own login kept in its own folder on the workstation, one per
 *    account, copied into each agent's private home for a session (the Claude machinery, with the same hardening);
 *  - **key accounts** (`anthropic`, `openai`, `google`, `openai-compatible`, and the Claude Code backends `bedrock`, `vertex`,
 *    `gateway`): the workstation's sealed provider key, in a slot per account name, with the name bound into the sealed blob.
 *
 * A shift has exactly one account, in the scope its agent's runtime and model name (`accountScopeOf`). Besides `main` and the
 * named accounts, a key scope has one more account a project may choose: the organization's key (`org`), whose monthly cap still
 * applies.
 */

/** Announced in `hello.capabilities` by runners that keep named accounts of the other runtimes and of the provider keys. */
export const PROVIDER_ACCOUNTS_CAPABILITY = 'provider-accounts:1';

/** A named account: never `main`, never `org`. */
export const ProviderAccountKeySchema = AccountKeySchema.refine(
  (k) => k !== MAIN_ACCOUNT && k !== ORG_ACCOUNT && !isReservedAccountName(k),
  { message: 'reserved' },
);

export const LOGIN_SCOPES = ['claude-code', CODEX_RUNTIME, GEMINI_RUNTIME] as const;
export type LoginScope = (typeof LOGIN_SCOPES)[number];
export const KEY_SCOPES = [...DIRECT_PROVIDER_IDS, ...BACKEND_IDS] as const;
export const ACCOUNT_SCOPE_IDS = [...LOGIN_SCOPES, ...KEY_SCOPES] as const;
export const AccountScopeSchema = z.enum(ACCOUNT_SCOPE_IDS);
export type AccountScope = z.infer<typeof AccountScopeSchema>;

export const isLoginScope = (s: string): s is LoginScope => (LOGIN_SCOPES as readonly string[]).includes(s);
export const isKeyScope = (s: string): s is ProviderKeyId => (KEY_SCOPES as readonly string[]).includes(s);

export interface AccountScopeDef {
  id: AccountScope;
  kind: 'login' | 'key';
  label: string;
  /** The runtime a login scope belongs to (its report carries `accounts[]`). */
  runtime?: string;
}

export const ACCOUNT_SCOPES: readonly AccountScopeDef[] = [
  { id: 'claude-code', kind: 'login', label: 'Claude Code', runtime: 'claude-code' },
  { id: 'codex', kind: 'login', label: 'Codex', runtime: CODEX_RUNTIME },
  { id: 'gemini', kind: 'login', label: 'Gemini CLI', runtime: GEMINI_RUNTIME },
  { id: 'anthropic', kind: 'key', label: 'Anthropic API' },
  { id: 'openai', kind: 'key', label: 'OpenAI' },
  { id: 'google', kind: 'key', label: 'Google Gemini API' },
  { id: 'openai-compatible', kind: 'key', label: 'OpenAI-compatible endpoint' },
  { id: 'bedrock', kind: 'key', label: 'Amazon Bedrock (Claude Code)' },
  { id: 'vertex', kind: 'key', label: 'Google Vertex AI (Claude Code)' },
  { id: 'gateway', kind: 'key', label: 'Anthropic-compatible gateway (Claude Code)' },
];

export const accountScopeDef = (id: string): AccountScopeDef | undefined =>
  ACCOUNT_SCOPES.find((s) => s.id === id);

/**
 * The scope of an agent's shift: whose account it spends, from the runtime and model. `claude-code` with a backend qualifier
 * (`bedrock:...`) spends that backend's credential; the Gemini CLI spends the Google login unless the runner says it runs on a key
 * (`authVia: 'key'`); opencode and the direct-model runtime spend the key of the provider in the model name. Null: no account
 * applies (mock, an unknown provider, an opencode model with no key behind it).
 */
export function accountScopeOf(
  runtime: string,
  model: string,
  authVia?: 'login' | 'key',
): AccountScope | null {
  if (runtime === 'claude-code') return splitBackendModel(model)?.backend ?? 'claude-code';
  if (runtime === CODEX_RUNTIME) return CODEX_RUNTIME;
  if (runtime === GEMINI_RUNTIME) return authVia === 'key' ? 'google' : GEMINI_RUNTIME;
  if (runtime === DIRECT_RUNTIME) return splitDirectModel(model)?.provider ?? null;
  if (runtime === OPENCODE_RUNTIME) {
    const head = model.split('/')[0] ?? '';
    return (DIRECT_PROVIDER_IDS as readonly string[]).includes(head) ? (head as AccountScope) : null;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ key accounts
// (`keyAccountUsable` and `keyAccountSource` live with the key facts they read: models/credentials.ts)

/**
 * The account a shift of `scope` runs on, on one workstation, or null = it waits. Login scopes read the runtime's `accounts[]`
 * (`login` and `usage`, as Claude's), key scopes the reported key facts. The project's choice falls back to main only when the
 * project allows it. Everything not tied to a ticket passes `null` and gets main.
 */
export function resolveScopeAccount(
  scope: AccountScope,
  setting: ProjectAccountSetting | null | undefined,
  rt: {
    /** The login runtime's report (login scopes). */
    login?: AccountRuntimeView | undefined;
    /** The workstation's reports (key scopes). */
    reports?: readonly KeyUseReport[] | undefined;
  },
  orgId: string | undefined,
  now: Date,
  /** The organization's monthly cap for this provider is reached: its key is not usable (the cap still applies). */
  orgCapped = false,
): { key: string; viaFallback: boolean } | null {
  if (isLoginScope(scope)) return resolveShiftAccount(setting, rt.login, now);
  const usable = (k: string) => keyAccountUsable(rt.reports, scope as ProviderKeyId, k, orgId, orgCapped);
  const key = setting?.accountKey;
  if (key && key !== MAIN_ACCOUNT) {
    if (usable(key)) return { key, viaFallback: false };
    if (setting.fallbackToMain && usable(MAIN_ACCOUNT)) return { key: MAIN_ACCOUNT, viaFallback: true };
    return null;
  }
  return usable(MAIN_ACCOUNT) ? { key: MAIN_ACCOUNT, viaFallback: false } : null;
}

// ------------------------------------------------------------------------------------------------ commands

/**
 * `provider.account.promote`: "Make main". A named account takes the place of main and the former main becomes the named account
 * (a swap, so nothing is lost and it can be undone). Login scopes swap the login folders in the runner's config; key scopes re-seal
 * both keys under their new names with this runner's own key (the name is part of what a blob is bound to). The answer says whether
 * it worked; no secret travels.
 */
export const ProviderAccountPromotePayloadSchema = z.object({
  scope: AccountScopeSchema,
  key: ProviderAccountKeySchema,
  /**
   * One id per click, set by the server. The runner remembers the ids it has applied and answers a repeat with the first answer
   * without swapping again (a command delivered twice would otherwise swap the accounts back). Absent from an older server.
   */
  nonce: z.string().min(8).max(64).optional(),
});
export type ProviderAccountPromotePayload = z.infer<typeof ProviderAccountPromotePayloadSchema>;
export const AccountSharingRequestSchema = z.object({ allow: z.boolean() });
export const ProviderAccountPromoteResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(300).optional(),
});
export type ProviderAccountPromoteResult = z.infer<typeof ProviderAccountPromoteResultSchema>;

// ------------------------------------------------------------------------------------------------ events and API

export const ProviderAccountChoiceSchema = z.object({
  /** null: the main account. A name, or `org` for a key scope. */
  key: AccountKeySchema.nullable(),
  fallbackToMain: z.boolean(),
});

/** `PUT /api/projects/:id/provider-accounts/:scope` (Claude Code's scope maps to its own setting). */
export const SetProviderAccountRequestSchema = z.object({
  accountKey: AccountKeySchema.nullable(),
  fallbackToMain: z.boolean().default(false),
});
export type SetProviderAccountRequest = z.infer<typeof SetProviderAccountRequestSchema>;

export const ProviderAccountStatusSchema = z.object({
  key: AccountKeySchema,
  main: z.boolean(),
  /** `login`: signed in / expired / none. `key`: a key is set. */
  kind: z.enum(['login', 'key']),
  /** Login accounts: the CLI's login. Key accounts: `ok` when a key is set. */
  login: z.enum(['ok', 'expired', 'none']),
  usage: z.enum(['ok', 'limited']).default('ok'),
  limitedUntil: z.string().max(40).optional(),
  email: z.string().max(200).optional(),
  /** Key accounts: whose key it is. */
  source: z.enum(['workstation', 'org']).optional(),
  detail: z.string().max(300).optional(),
});
export type ProviderAccountStatus = z.infer<typeof ProviderAccountStatusSchema>;

export const ProjectProviderAccountsViewSchema = z.object({
  scope: AccountScopeSchema,
  label: z.string(),
  kind: z.enum(['login', 'key']),
  setting: ProviderAccountChoiceSchema,
  /** Account names reported by any workstation serving the organization (for the picker), plus `org` when it has a key here. */
  knownKeys: z.array(AccountKeySchema),
  /** The organization holds a key for this provider (key scopes), so `org` is a choice. */
  orgKey: z.boolean().default(false),
  workstations: z.array(
    z.object({
      workstationId: z.uuid(),
      name: z.string(),
      connected: z.boolean(),
      supportsAccounts: z.boolean(),
      /** The project's chosen account on this workstation; absent = missing there. */
      account: ProviderAccountStatusSchema.optional(),
      main: ProviderAccountStatusSchema.optional(),
    }),
  ),
});
export type ProjectProviderAccountsView = z.infer<typeof ProjectProviderAccountsViewSchema>;

/** `ProjectDto.providerAccounts`: the project's choice per scope other than Claude Code's (which has `claudeAccount`). */
export const ProjectProviderAccountsSchema = z.record(z.string(), ProviderAccountChoiceSchema);

// ------------------------------------------------------------------------------------------------ the AI runtime tiles

export const AI_RUNTIME_INSTALL_HINTS: Readonly<Record<string, string>> = {
  'claude-code': 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  gemini: 'npm install -g @google/gemini-cli',
  opencode: 'npm install -g opencode-ai',
};

/** One row of a tile: an account of a runtime or provider on a workstation. */
export const AiRuntimeAccountSchema = z.object({
  key: AccountKeySchema,
  main: z.boolean(),
  kind: z.enum(['login', 'key']),
  /** Login accounts: `ok`, `expired`, `none`. Key accounts: `ok` (a key is set) or `none`. */
  state: z.enum(['ok', 'expired', 'none']),
  usage: z.enum(['ok', 'limited']).default('ok'),
  limitedUntil: z.string().max(40).optional(),
  email: z.string().max(200).optional(),
  source: z.enum(['workstation', 'org']).optional(),
  /** The organization's key is stored here as well (overridden by this workstation's own). */
  orgKey: z.boolean().optional(),
  detail: z.string().max(300).optional(),
  /** Can "Make main" be offered for it (a named account of a scope that supports swapping). */
  canPromote: z.boolean().default(false),
});
export type AiRuntimeAccount = z.infer<typeof AiRuntimeAccountSchema>;

export const AiRuntimeTileSchema = z.object({
  /** The scope id, or `opencode` (no accounts of its own). */
  id: z.string(),
  label: z.string(),
  kind: z.enum(['login', 'key', 'runtime']),
  /** The program is installed (login scopes and opencode); null where there is no program (API providers). */
  installed: z.boolean().nullable(),
  version: z.string().optional(),
  installHint: z.string().optional(),
  /** The runner is older than the accounts feature (`provider-accounts:1`): "update the runner". */
  runnerTooOld: z.boolean(),
  accounts: z.array(AiRuntimeAccountSchema),
  /** Key scopes: which key is in effect for the main account. */
  keyInEffect: z.enum(['workstation', 'org', 'none']).optional(),
  /** The Integrations kind id for the login actions (sign in, remove), when the scope has one. */
  integrationKind: z.string().optional(),
  note: z.string().max(300).optional(),
});
export type AiRuntimeTile = z.infer<typeof AiRuntimeTileSchema>;

export const AiRuntimesResponseSchema = z.object({
  workstationId: z.uuid(),
  online: z.boolean(),
  runnerVersion: z.string().nullable(),
  tiles: z.array(AiRuntimeTileSchema),
  /** The last answer to "Make main" in this server process (transient, for the page right after the click). */
  lastPromote: z
    .object({
      scope: z.string(),
      key: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
      at: z.iso.datetime(),
    })
    .nullable()
    .default(null),
  /**
   * Projects (visible to the owner) that name an account of a scope explicitly (`main` or a named one): "Make main" changes what
   * these get, so the confirmation lists them. Projects with no choice follow the main account and are not listed.
   */
  /** "Allow projects to use my accounts": projects the owner is not a member of may name a named account here. Default off. */
  shareAccounts: z.boolean().default(false),
  pinnedProjects: z
    .array(
      z.object({
        scope: z.string(),
        account: z.string(),
        projectKey: z.string(),
        projectName: z.string(),
      }),
    )
    .default([]),
});
export type AiRuntimesResponse = z.infer<typeof AiRuntimesResponseSchema>;

interface RuntimeReportLike {
  id: string;
  version?: string;
  available: boolean;
  auth?: 'ok' | 'expired' | undefined;
  usage?: 'ok' | 'limited' | undefined;
  limitedUntil?: string | undefined;
  accounts?: z.infer<typeof ClaudeAccountInfoSchema>[] | undefined;
  keys?: KeyUseReport['keys'];
  authVia?: 'login' | 'key' | undefined;
}

/**
 * The tiles of Integrations > AI runtime for one workstation, from what its runner reported: pure, so the page, the server route and
 * the tests share it. `capabilities` are the runner's announced ones (`provider-accounts:1` says it keeps named accounts).
 */
export function buildAiRuntimeTiles(input: {
  runtimes: readonly RuntimeReportLike[];
  capabilities: readonly string[];
}): AiRuntimeTile[] {
  const { runtimes } = input;
  const accountsOk = input.capabilities.includes(PROVIDER_ACCOUNTS_CAPABILITY);
  const rt = (id: string) => runtimes.find((r) => r.id === id);
  const tiles: AiRuntimeTile[] = [];

  const loginTile = (def: AccountScopeDef): AiRuntimeTile => {
    const r = rt(def.runtime as string);
    const hint = AI_RUNTIME_INSTALL_HINTS[def.id];
    // Claude Code has always had accounts (0.1.33); the others need provider-accounts:1
    const tooOld = def.id === 'claude-code' ? !input.capabilities.includes('claude-accounts:1') : !accountsOk;
    const accounts: AiRuntimeAccount[] = (r?.accounts ?? []).map((a) => ({
      key: a.key,
      main: a.main,
      kind: 'login' as const,
      state: a.login,
      usage: a.usage,
      ...(a.limitedUntil ? { limitedUntil: a.limitedUntil } : {}),
      ...(a.email ? { email: a.email } : {}),
      ...(a.detail ? { detail: a.detail } : {}),
      canPromote: !a.main && def.id !== 'claude-code',
    }));
    // A runner that reports no accounts[] (older): its top-level login is the main account.
    if (r && !r.accounts)
      accounts.push({
        key: MAIN_ACCOUNT,
        main: true,
        kind: 'login',
        state: r.auth === 'expired' ? 'expired' : 'ok',
        usage: r.usage ?? 'ok',
        ...(r.limitedUntil ? { limitedUntil: r.limitedUntil } : {}),
        canPromote: false,
      });
    return {
      id: def.id,
      label: def.label,
      kind: 'login',
      installed: def.id === 'claude-code' ? true : !!r,
      ...(r?.version && r.version !== 'unknown' ? { version: r.version } : {}),
      ...(!r && hint ? { installHint: hint } : {}),
      runnerTooOld: tooOld,
      accounts,
      integrationKind: def.id,
      ...(!r
        ? { note: 'The runner looks for the program when it starts: restart the runner after installing it.' }
        : {}),
    };
  };

  for (const def of ACCOUNT_SCOPES.filter((s) => s.kind === 'login')) tiles.push(loginTile(def));

  const opencode = rt(OPENCODE_RUNTIME);
  tiles.push({
    id: 'opencode',
    label: 'opencode',
    kind: 'runtime',
    installed: !!opencode,
    ...(opencode?.version && opencode.version !== 'unknown' ? { version: opencode.version } : {}),
    ...(!opencode ? { installHint: AI_RUNTIME_INSTALL_HINTS.opencode as string } : {}),
    runnerTooOld: false,
    accounts: [],
    note: 'opencode uses the provider keys below: pick the key account of the provider its model names.',
  });

  const keysOf = rt(DIRECT_RUNTIME)?.keys;
  for (const def of ACCOUNT_SCOPES.filter((s) => s.kind === 'key')) {
    const k = keysOf?.find((x) => x.provider === def.id);
    const accounts: AiRuntimeAccount[] = [];
    const hasMain = !!k && k.main !== false;
    accounts.push({
      key: MAIN_ACCOUNT,
      main: true,
      kind: 'key',
      state: hasMain ? 'ok' : 'none',
      usage: 'ok',
      ...(hasMain ? { source: k.source } : {}),
      ...(hasMain && k.orgIds?.length && k.source === 'workstation' ? { orgKey: true } : {}),
      canPromote: false,
    });
    for (const name of k?.accounts ?? [])
      accounts.push({
        key: name,
        main: false,
        kind: 'key',
        state: 'ok',
        usage: 'ok',
        source: 'workstation',
        canPromote: true,
      });
    tiles.push({
      id: def.id,
      label: def.label,
      kind: 'key',
      installed: null,
      runnerTooOld: keysOf === undefined || !accountsOk,
      accounts,
      keyInEffect: hasMain ? k.source : 'none',
    });
  }
  return tiles;
}
