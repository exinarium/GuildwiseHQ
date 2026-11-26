import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { HarnessLaunch } from '../adapters/harness-session.ts';
import type { EgressRoute, RouteObserver } from '../sandbox/egress-proxy.ts';
import type { BoxLevel } from './config-dir.ts';
import { anthropicRequestFilter, type ModelCapture, type ServerTools } from './model-filter.ts';

/**
 * quiet-approvals phase B: the two DevOps boxes the runner builds itself (D7 (b)) around Claude Code, whose own sandbox is
 * then off (never nested). Built on the harness sandbox (bubblewrap, an empty root, `--unshare-net`, the egress proxy on
 * a Unix socket bridged to 127.0.0.1:3128 in the box) with the DevOps hardening (`--disable-userns`, no capabilities).
 *
 * Mount plan (an allowlist, round-6 condition: never the whole agent dir writable):
 * - writable: the request's own folder (its cwd and scratch root), its config dir `config/<level>/<request>` (with HOME
 *   inside it), its private tmp; the outer box also the DevOps tool prefix `<root>/devops-tools`;
 * - read-only: the system (`/usr`, `/etc` minus `ssh/`), the runner's bin and the `aom` script, Claude Code's install and
 *   the runner's Node, the toolchains, the project's clones; the outer box also the card worktrees, the main clones,
 *   `~/.ssh` and `~/.gitconfig` (git credentials, never writable);
 * - never there: the policy dir, `held/`, `window/`, `keys/`, every other agent's dir, `~/.claude*` and the account dirs,
 *   `/run/user/<uid>`, `~/.config/systemd`, the Docker socket and the host's `/proc`.
 *
 * No AI login in any box (S4, S10): Claude Code talks to the runner's model proxy (a route of the egress proxy) with a
 * per-session bearer; the proxy forwards only `/v1/messages` and `/v1/messages/count_tokens` and adds the real credential
 * outside the box. The bearer dies with the session (the proxy closes).
 */

export const MODEL_ROUTE = '/anthropic';
export const MODEL_PATHS: readonly string[] = ['/v1/messages', '/v1/messages/count_tokens'];
export const MODEL_UPSTREAM = 'https://api.anthropic.com';

/**
 * runner-bare-bin (S5): model services a box never reaches directly (a CONNECT or a plain request): Claude Code reaches its
 * model only through the route, whose filter and ledger apply. Each entry covers the host and its subdomains.
 */
export const MODEL_API_HOSTS: readonly string[] = [
  'anthropic.com',
  'claude.ai',
  'claude.com',
  'openai.com',
  'generativelanguage.googleapis.com',
  'aiplatform.googleapis.com',
  'openrouter.ai',
];

/** Is `host` (or an allow-list entry such as `*.anthropic.com`) a model service of `MODEL_API_HOSTS` or Bedrock? */
export function isModelApiHost(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/^\*\./, '')
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  if (/^bedrock-runtime(-fips)?\.[a-z0-9-]+\.amazonaws\.com$/.test(h)) return true;
  return MODEL_API_HOSTS.some((m) => h === m || h.endsWith(`.${m}`));
}

/** The beta a Claude login or OAuth token needs upstream (S6: added after the filter, so a box cannot strip it). */
export const OAUTH_BETA = 'oauth-2025-04-20';

/** The credential the runner holds for Claude Code on this computer (never put into a box). */
export type ModelCredential =
  | { kind: 'api_key'; apiKey: string }
  | { kind: 'oauth_token'; token: string }
  /** A Claude login (`.credentials.json`): the access token is read per request, so the runner's refresh outside applies. */
  | { kind: 'login'; credentialsFile: string };

export interface ModelProxyPlan {
  route: EgressRoute;
  /** What the box's Claude Code gets instead of a credential. */
  env: Record<string, string>;
  bearer: string;
}

/** The access token of a Claude login file, or null (missing, unreadable, expired by its own clock). */
export function loginAccessToken(file: string, now: number = Date.now()): string | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const t = j.claudeAiOauth?.accessToken;
    const exp = Number(j.claudeAiOauth?.expiresAt ?? 0);
    if (typeof t !== 'string' || !t) return null;
    if (exp && exp < now) return null;
    return t;
  } catch {
    return null;
  }
}

export interface ModelRouteOptions {
  /** B1: which server tools the session's requests may use (`web_search` only where its settings allow WebSearch). */
  serverTools?: ServerTools;
  /** B2: the session's ledger (usage, login and limits, the audit), fed outside the box. */
  observe?: RouteObserver;
  /** B6: a constructor test hook only; it reports and never changes what is refused or stripped. */
  capture?: ModelCapture;
}

/**
 * S10: the model proxy route and the box's placeholder environment, per auth mode. runner-bare-bin (B1, B4, S6, S9): every
 * request is rebuilt from a checked value (`anthropicRequestFilter`), with only allowlisted headers, and the auth mode's
 * required beta added last.
 */
export function modelProxyPlan(
  cred: ModelCredential,
  upstream: string = MODEL_UPSTREAM,
  o: ModelRouteOptions = {},
): ModelProxyPlan {
  const nonce = randomBytes(24).toString('base64url');
  const base = {
    prefix: MODEL_ROUTE,
    upstream,
    allowPaths: [...MODEL_PATHS],
    requestFilter: anthropicRequestFilter({
      serverTools: o.serverTools ?? 'none',
      ...(o.capture ? { capture: o.capture } : {}),
    }),
    ...(o.observe ? { observe: o.observe } : {}),
  };
  if (cred.kind === 'api_key') {
    const bearer = `sk-ant-api03-box-${nonce}`;
    return {
      bearer,
      route: { ...base, headers: { 'x-api-key': cred.apiKey }, bearer },
      env: { ANTHROPIC_API_KEY: bearer },
    };
  }
  const bearer = `sk-ant-oat01-box-${nonce}`;
  if (cred.kind === 'oauth_token')
    return {
      bearer,
      route: {
        ...base,
        headers: { authorization: `Bearer ${cred.token}` },
        requiredHeaders: { 'anthropic-beta': OAUTH_BETA },
        bearer,
      },
      env: { CLAUDE_CODE_OAUTH_TOKEN: bearer },
    };
  const file = cred.credentialsFile;
  return {
    bearer,
    route: {
      ...base,
      headers: {},
      requiredHeaders: { 'anthropic-beta': OAUTH_BETA },
      bearer,
      dynamicHeaders: () => {
        const t = loginAccessToken(file);
        return t ? { authorization: `Bearer ${t}` } : null;
      },
    },
    env: { CLAUDE_CODE_OAUTH_TOKEN: bearer },
  };
}

/** The environment every boxed Claude Code gets on top of its session's: the model through the proxy, nothing else. */
export function boxedClaudeEnv(plan: ModelProxyPlan, bridgePort: number): Record<string, string> {
  return {
    ...plan.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridgePort}${MODEL_ROUTE}`,
    // spike (day 1, Claude Code 2.1.331): with this set it calls only the base URL; otherwise api.anthropic.com too
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    // runner-bare-bin (B1): features switched off so every request fits the route's fixed allowlist; both only remove betas and
    // fields (tool search with `defer_loading`, per-turn and mid-conversation controls), never add any
    ENABLE_TOOL_SEARCH: 'false',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  };
}

export interface BoxPlanInput {
  level: BoxLevel;
  /** The request's own folder (cwd, scratch root): writable. */
  requestDir: string;
  /** `config/<level>/<request>`: writable; HOME is inside it. */
  configDir: string;
  /** The request's private tmp: writable. */
  tmp: string;
  /** The runner's `bin/` and the `aom` script's folder. */
  aomReadPaths: string[];
  /** Claude Code's binary (its install is read-only in the box). */
  claudeBin: string;
  /** Toolchain folders agents may read. */
  toolchainReadDirs: string[];
  /** The project's clones (read-only, secret files masked). */
  cloneDirs: string[];
  /** The runner's IPC socket (`aom`). */
  ipcSocket?: string;
  /** Outer box only. */
  outer?: {
    devopsTools: string;
    cardWorktrees: string;
    realHome: string;
  };
  fdBinds?: Array<{ fdIndex: number; real: string; writable: boolean }>;
}

const realDir = (p: string): string | null => {
  try {
    return dirname(realpathSync(p));
  } catch {
    return null;
  }
};

/**
 * The mount plan of a box (the harness sandbox input without the proxy socket and bridge). runner-bare-bin: `claudeBin` is the
 * checked real path from `lookupBin`; a bare or relative name throws (it used to resolve against the cwd, so a file named
 * `claude` there would have had its folder bound).
 */
export function boxSandbox(i: BoxPlanInput): HarnessLaunch['sandbox'] {
  if (!isAbsolute(i.claudeBin))
    throw new Error(`the box needs the checked absolute path of Claude Code, not "${i.claudeBin}"`);
  const node = realDir(process.execPath);
  const claude = realDir(i.claudeBin);
  const ro = [
    ...i.aomReadPaths,
    ...(claude ? [claude] : []),
    ...(node && !node.startsWith('/usr/') ? [node] : []),
    ...i.toolchainReadDirs,
  ];
  if (i.outer) {
    ro.push(i.outer.cardWorktrees);
    for (const f of ['.ssh', '.gitconfig']) {
      const p = join(i.outer.realHome, f);
      if (existsSync(p)) ro.push(p);
    }
  }
  return {
    cwd: i.requestDir,
    readOnlyCwd: false,
    home: join(i.configDir, 'home'),
    scratch: i.requestDir,
    tmp: i.tmp,
    writable: [i.configDir, ...(i.outer ? [i.outer.devopsTools] : [])],
    readonly: [...new Set(ro)],
    readDirs: i.cloneDirs,
    gitDirs: [],
    mayCommit: false,
    ...(i.ipcSocket ? { ipcSocket: i.ipcSocket } : {}),
    devopsBox: true,
    ...(i.fdBinds?.length ? { fdBinds: i.fdBinds } : {}),
  };
}
