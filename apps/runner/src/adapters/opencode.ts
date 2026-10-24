import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type AgentPermissions, OPENCODE_RUNTIME, type ReportedModel, runtimeRoleProblem } from '@aom/shared';
import { execa } from 'execa';
import { materializeSkills } from '../capabilities/materialize.ts';
import type { OpencodeRuntimeConfig } from '../config.ts';
import type { ProviderConfig, ProviderStore } from '../direct/store.ts';
import type { RunnerPaths } from '../paths.ts';
import type { EgressRoute } from '../sandbox/egress-proxy.ts';
import { DOTNET_SHM_DIR, userNugetPackages } from '../sandbox/sandbox.ts';
import { selfCommand } from '../shims.ts';
import { agentEnv, toolchainReadPaths } from './claude-policy.ts';
import { findBinary, gitCommonDirs } from './codex.ts';
import { deniedShellPrefixes } from './denied-shell.ts';
import {
  BRIDGE_PORT,
  type HarnessLaunch,
  installDirsOf,
  type LaunchedHarness,
  launchInHarnessSandbox,
  probeHarnessSandbox,
} from './harness-session.ts';
import { OpencodeStreamParser, opencodeUsageLimit } from './opencode-stream-parser.ts';
import { spawnSession } from './process-session.ts';
import type {
  ChatStartInput,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeSession,
  ShiftStartInput,
} from './types.ts';

/**
 * The opencode runtime (docs/RUNNER.md, "opencode runtime"). Verified against opencode 1.19.4 (npm `opencode-ai`, 2026-10-24) by
 * running the real binary against a fake OpenAI-compatible API; the facts used are:
 * - `opencode run --format json -m <provider>/<model> [-s <session id>]` reads the prompt from stdin when there is no message and
 *   prints one JSON event per line (`opencode-stream-parser.ts`).
 * - Everything the runner decides travels in the environment, so no file of the owner or the repository can loosen it:
 *   `OPENCODE_CONFIG_CONTENT` (inline config, the highest-priority layer: providers, permissions, instructions),
 *   `OPENCODE_DISABLE_PROJECT_CONFIG` (a repository's `opencode.json`, `.opencode/` and AGENTS.md are not read; the repository's
 *   AGENTS.md is added by path), `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_EXTERNAL_SKILLS`, `OPENCODE_DISABLE_MODELS_FETCH`,
 *   `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_PURE` (no plugins), and the XDG folders (private per agent).
 * - Permissions are rules per tool, the last matching rule wins: `bash: {"*": "deny", "aom *": "allow"}` is the shell of a role
 *   without one. Its own `opencode` provider (hosted free models) is not enabled: `enabled_providers` lists only the keys held here.
 * - The keys never enter the sandbox. Each provider's `baseURL` is a route on the runner's egress proxy
 *   (`http://127.0.0.1:3128/<provider>`) with a dummy key; the proxy adds the real key to the request.
 * - Global instructions are `<XDG_CONFIG_HOME>/opencode/AGENTS.md`, user skills `<XDG_CONFIG_HOME>/opencode/skills/<name>/SKILL.md`.
 */
export const OPENCODE_VERIFIED_VERSION = '1.19.4';
export const OPENCODE_MIN_VERSION: readonly [number, number, number] = [1, 19, 4];

type OpencodeConfig = OpencodeRuntimeConfig & { bin: string };
type SandboxInfo = Pick<ShiftStartInput['sandbox'], 'home' | 'configDir' | 'scratch' | 'tmp' | 'cacheRoot'>;

export function detectOpencode(
  cfg: OpencodeRuntimeConfig | undefined,
  opts: { platform?: NodeJS.Platform; pathVar?: string; home?: string; blocked?: boolean } = {},
): string | undefined {
  if (cfg?.enabled === false) return undefined;
  if ((opts.platform ?? process.platform) !== 'linux') return undefined;
  if (opts.blocked && !cfg?.bin) return undefined;
  return findBinary(cfg?.bin ?? 'opencode', opts.pathVar, opts.home);
}

/** The agent's private opencode root: `agents/<id>/opencode` with `config`, `data`, `cache` and `state` (the XDG folders). */
export const opencodeHomeOf = (sandbox: Pick<SandboxInfo, 'configDir'>): string =>
  join(dirname(sandbox.configDir), 'opencode');

export const opencodeInstallDirs = (bin: string): string[] =>
  installDirsOf(bin, ['opencode-ai'], realpathSync);

// ------------------------------------------------------------------------------------------------ providers

/** The providers opencode can be given: the keys of the direct-model store, by the id the store uses. */
export const OPENCODE_PROVIDERS = ['anthropic', 'openai', 'google', 'openai-compatible'] as const;

/** A key the proxy adds is never in the sandbox; this stands in for it where opencode insists on one. */
export const DUMMY_KEY = 'aom-key-is-added-by-the-runner';

const routePrefix = (id: string): string => (id === 'openai-compatible' ? '/compat' : `/${id}`);

/** The egress route that carries one provider's calls, with the real key in its headers. */
export function opencodeRoute(p: ProviderConfig): EgressRoute | undefined {
  const key = p.apiKey;
  switch (p.id) {
    case 'anthropic':
      return {
        prefix: routePrefix(p.id),
        upstream: 'https://api.anthropic.com',
        headers: key ? { 'x-api-key': key } : {},
      };
    case 'openai':
      return {
        prefix: routePrefix(p.id),
        upstream: 'https://api.openai.com',
        headers: key ? { authorization: `Bearer ${key}` } : {},
      };
    case 'google':
      return {
        prefix: routePrefix(p.id),
        upstream: 'https://generativelanguage.googleapis.com',
        headers: key ? { 'x-goog-api-key': key } : {},
      };
    case 'openai-compatible': {
      if (!p.baseUrl) return undefined;
      return {
        prefix: routePrefix(p.id),
        upstream: p.baseUrl,
        headers: key ? { authorization: `Bearer ${key}` } : {},
        // the owner entered this endpoint (Ollama on this machine, a LAN server): only this route may reach it
        allowPrivateUpstream: true,
      };
    }
    default:
      return undefined;
  }
}

/** The inline `provider` section for the providers held here: every `baseURL` is a route on the proxy, every key a stand-in. */
export function opencodeProviderConfig(providers: readonly ProviderConfig[]): Record<string, unknown> {
  const base = `http://127.0.0.1:${BRIDGE_PORT}`;
  const out: Record<string, unknown> = {};
  for (const p of providers) {
    if (p.id === 'anthropic')
      out.anthropic = { options: { baseURL: `${base}${routePrefix(p.id)}/v1`, apiKey: DUMMY_KEY } };
    else if (p.id === 'openai')
      out.openai = { options: { baseURL: `${base}${routePrefix(p.id)}/v1`, apiKey: DUMMY_KEY } };
    else if (p.id === 'google')
      out.google = { options: { baseURL: `${base}${routePrefix(p.id)}/v1beta`, apiKey: DUMMY_KEY } };
    else if (p.id === 'openai-compatible' && p.baseUrl)
      out['openai-compatible'] = {
        npm: '@ai-sdk/openai-compatible',
        name: 'OpenAI-compatible endpoint',
        options: { baseURL: `${base}${routePrefix(p.id)}`, apiKey: DUMMY_KEY },
        models: Object.fromEntries(p.models.map((m) => [m, { name: m }])),
      };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ permissions

export interface OpencodePermissionInput {
  perms: Pick<AgentPermissions, 'allowedTools' | 'deniedShellPatterns'>;
  roleKey: string;
  /** A chat: it reads and talks, its shell is `aom` only. */
  chat: boolean;
}

/**
 * The `permission` section. The last rule that matches wins, so the order is: everything, then the exceptions.
 * - the shell: free for a role with `shell`; `aom ...` only for a role without one and for every chat; the role's denied command
 *   prefixes (`git push`, ...) refused in both;
 * - `edit` (write, edit, patch): only for a role with `edit` and not in a chat;
 * - `webfetch`: only with `web`; web search and code search are never offered (they go to a service of the CLI's vendor);
 * - an access outside the working folder, a repeated-call loop, a question to a person: refused, nobody is there to answer.
 */
export function opencodePermission(i: OpencodePermissionInput): Record<string, unknown> {
  const tools = i.perms.allowedTools;
  const aomOnly = !tools.includes('shell') || i.chat;
  const bash: Record<string, string> = aomOnly
    ? { '*': 'deny', aom: 'allow', 'aom *': 'allow' }
    : { '*': 'allow' };
  for (const prefix of deniedShellPrefixes(i.perms, i.roleKey)) {
    bash[prefix] = 'deny';
    bash[`${prefix} *`] = 'deny';
  }
  return {
    bash,
    edit: tools.includes('edit') && !i.chat ? 'allow' : 'deny',
    webfetch: tools.includes('web') ? 'allow' : 'deny',
    websearch: 'deny',
    codesearch: 'deny',
    external_directory: 'deny',
    doom_loop: 'deny',
    question: 'deny',
  };
}

// ------------------------------------------------------------------------------------------------ command

export interface OpencodeCommandInput {
  prompt: string;
  model: string;
  resumeSessionId?: string;
  sessionEnv: Record<string, string>;
  /** The inline config (`OPENCODE_CONFIG_CONTENT`). */
  configContent: Record<string, unknown>;
  ohome: string;
}

/** An opencode session id: `ses_` and letters and digits. */
const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]{10,40}$/;

/** The exact argv/env of an `opencode run` session (docs/RUNNER.md). The prompt is on stdin. Pure; unit tested. */
export function buildOpencodeCommand(
  i: OpencodeCommandInput,
  cfg: Pick<OpencodeConfig, 'bin'>,
  parent: NodeJS.ProcessEnv = process.env,
): { bin: string; args: string[]; env: Record<string, string>; stdin: string } {
  const args = ['run', '--format', 'json', `--model=${i.model}`];
  if (i.resumeSessionId && OPENCODE_SESSION_ID.test(i.resumeSessionId))
    args.push('--session', i.resumeSessionId);
  const env = agentEnv(i.sessionEnv, {}, parent, {
    XDG_CONFIG_HOME: join(i.ohome, 'config'),
    XDG_DATA_HOME: join(i.ohome, 'data'),
    XDG_CACHE_HOME: join(i.ohome, 'cache'),
    XDG_STATE_HOME: join(i.ohome, 'state'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(i.configContent),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_PURE: '1',
    NO_COLOR: '1',
  });
  return { bin: cfg.bin, args, env, stdin: i.prompt };
}

// ------------------------------------------------------------------------------------------------ the adapter

export interface OpencodeHost {
  platform?: NodeJS.Platform;
  home?: string;
  parent?: NodeJS.ProcessEnv;
  now?: () => Date;
  sandboxProbe?: () => { ok: boolean; reason: string };
  /** Test hook: start the command without the sandbox. */
  launch?: (l: HarnessLaunch) => Promise<LaunchedHarness>;
  /** Test hook: the model list opencode reports for a set of configured providers. */
  listModels?: (providers: readonly ProviderConfig[]) => Promise<string[]>;
  /** Test hook: a fake API on localhost, reached through the routes. */
  proxyTest?: HarnessLaunch['proxyTest'];
  /** Test hook: where a provider's route really goes (a fake of its API on localhost). */
  routeUpstream?: (providerId: string) => string | undefined;
}

const MODELS_TTL_MS = 10 * 60_000;

export class OpencodeAdapter implements RuntimeAdapter {
  readonly id = OPENCODE_RUNTIME;
  private modelsCache: { at: number; key: string; ids: string[] } | undefined;

  constructor(
    private readonly cfg: OpencodeConfig,
    private readonly paths: RunnerPaths | undefined,
    private readonly store: ProviderStore | undefined,
    private readonly host: OpencodeHost = {},
  ) {}

  private realHome(): string {
    return this.host.home ?? homedir();
  }

  private parentEnv(): NodeJS.ProcessEnv {
    return this.host.parent ?? process.env;
  }

  /** The providers this workstation holds keys (or an endpoint) for, workstation key over organization key. */
  providers(orgId?: string): ProviderConfig[] {
    return (this.store?.configured(orgId) ?? []).filter((p) =>
      (OPENCODE_PROVIDERS as readonly string[]).includes(p.id),
    );
  }

  private sandboxProblem(): { ok: boolean; reason: string } {
    return (this.host.sandboxProbe ?? (() => probeHarnessSandbox(this.host.platform)))();
  }

  /**
   * The models opencode offers for the providers held here: `opencode models` against its built-in model list (no network:
   * `OPENCODE_DISABLE_MODELS_FETCH`), with stand-in keys. Cached for ten minutes per set of providers.
   */
  async listModels(providers: readonly ProviderConfig[]): Promise<string[]> {
    if (providers.length === 0) return [];
    const key = providers.map((p) => `${p.id}:${p.models.join(',')}`).join('|');
    const now = (this.host.now?.() ?? new Date()).getTime();
    if (this.modelsCache && this.modelsCache.key === key && now - this.modelsCache.at < MODELS_TTL_MS)
      return this.modelsCache.ids;
    let ids: string[];
    if (this.host.listModels) ids = await this.host.listModels(providers);
    else {
      const scratch = join(this.paths?.root ?? this.realHome(), '.opencode-models-probe');
      mkdirSync(scratch, { recursive: true });
      try {
        const r = await execa(this.cfg.bin, ['models'], {
          reject: false,
          timeout: 30_000,
          stdin: 'ignore',
          extendEnv: false,
          env: {
            PATH: this.parentEnv().PATH ?? '',
            HOME: scratch,
            XDG_CONFIG_HOME: join(scratch, 'c'),
            XDG_DATA_HOME: join(scratch, 'd'),
            XDG_CACHE_HOME: join(scratch, 'ca'),
            XDG_STATE_HOME: join(scratch, 's'),
            OPENCODE_DISABLE_MODELS_FETCH: '1',
            OPENCODE_DISABLE_AUTOUPDATE: '1',
            OPENCODE_DISABLE_PROJECT_CONFIG: '1',
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              enabled_providers: providers.map((p) => p.id),
              provider: opencodeProviderConfig(providers),
            }),
          },
        });
        ids = String(r.stdout)
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /^[A-Za-z0-9-]+\/\S+$/.test(l));
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    const wanted = new Set(providers.map((p) => p.id));
    ids = [...new Set(ids)].filter((id) => wanted.has(id.split('/')[0] as never));
    this.modelsCache = { at: now, key, ids };
    return ids;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    const caps = ['shell', 'edit', 'web', 'skills', 'resume'];
    const providers = this.providers();
    const auth = providers.length > 0 ? ('ok' as const) : ('expired' as const);
    let version = 'unknown';
    const down = (reason: string, models?: ReportedModel[]): RuntimeCapabilities => ({
      runtime: this.id,
      version,
      available: false,
      capabilities: [],
      sandbox: 'unavailable',
      sandboxReason: reason,
      auth,
      ...(models?.length ? { models } : {}),
    });
    try {
      const r = await execa(this.cfg.bin, ['--version'], { reject: false, timeout: 20_000, stdin: 'ignore' });
      const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(r.stdout));
      if (r.exitCode !== 0 || !m) return down('opencode --version failed');
      version = m[0];
      const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const [x, y, z] = OPENCODE_MIN_VERSION;
      if (a < x || (a === x && (b < y || (b === y && c < z))))
        return down(
          `opencode ${version} is older than ${OPENCODE_MIN_VERSION.join('.')}, the oldest version whose flags and environment switches were checked: update it (npm i -g opencode-ai)`,
        );
    } catch {
      return down('the opencode binary does not run');
    }
    const sb = this.sandboxProblem();
    let models: ReportedModel[] = [];
    try {
      models = (await this.listModels(providers)).map((id) => ({ id, label: id }));
    } catch {
      // a list that cannot be read: the runtime still works, the pickers have nothing to offer for it
    }
    const ok = sb.ok && auth === 'ok';
    return {
      runtime: this.id,
      version,
      available: ok,
      capabilities: ok ? caps : [],
      sandbox: sb.ok ? 'enforced' : 'unavailable',
      sandboxReason: sb.reason,
      auth,
      ...(models.length ? { models: models.slice(0, 400) } : {}),
    };
  }

  /** `AGENTS.md` in the agent's private config folder: opencode's global instructions. The text is the shared renderer's, verbatim. */
  async writeInstructions(sandbox: Pick<SandboxInfo, 'configDir'>, markdown: string): Promise<void> {
    const dir = join(opencodeHomeOf(sandbox), 'config', 'opencode');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'AGENTS.md'), markdown);
  }

  // -------------------------------------------------------------------------------------------- session

  private assertRole(roleKey: string, isDevops: boolean | undefined, permissions: AgentPermissions): void {
    const problem = runtimeRoleProblem(OPENCODE_RUNTIME, {
      roleKey,
      isDevops: isDevops === true,
      permissions,
    });
    if (problem) throw new Error(`runtime_role_refused: ${problem}`);
  }

  /** The provider an agent's model names, with its key; throws when it is not set up here. */
  private providerOf(model: string, orgId?: string): ProviderConfig {
    const id = model.split('/')[0] ?? '';
    const p = this.providers(orgId).find((x) => x.id === id);
    if (!p)
      throw new Error(
        `${id || 'the provider'} is not set up on this workstation: add its key under Workstations > Model providers (or ask an Owner or Admin to share the organization's)`,
      );
    return p;
  }

  private sessionEnv(input: { env: Record<string, string> }): Record<string, string> {
    const { CLAUDE_CONFIG_DIR: _c, ...rest } = input.env;
    return {
      ...rest,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'maintenance.auto',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'gc.auto',
      GIT_CONFIG_VALUE_1: '0',
    };
  }

  private async run(
    input: ShiftStartInput | ChatStartInput,
    opts: {
      prompt: string;
      chat: boolean;
      readOnlyCwd: boolean;
      mayCommit: boolean;
      perms: AgentPermissions;
      roleKey: string;
    },
  ): Promise<RuntimeSession> {
    const sb = this.sandboxProblem();
    if (!sb.ok) throw new Error(`the opencode sandbox is unavailable: ${sb.reason}`);
    const used = this.providerOf(input.agent.model, input.orgId);
    const all = this.providers(input.orgId);
    const ohome = opencodeHomeOf(input.sandbox);
    const confDir = join(ohome, 'config', 'opencode');
    for (const d of ['config', 'data', 'cache', 'state'].map((x) => join(ohome, x)))
      mkdirSync(d, { recursive: true, mode: 0o700 });
    mkdirSync(confDir, { recursive: true, mode: 0o700 });
    // the granted skills, exactly: nothing from the owner or an earlier shift
    materializeSkills(join(confDir, 'skills'), input.grantedSkills ?? [], ohome);
    rmSync(join(confDir, 'skill'), { recursive: true, force: true });
    const repoAgents = join(input.cwd, 'AGENTS.md');
    const configContent = {
      $schema: 'https://opencode.ai/config.json',
      enabled_providers: all.map((p) => p.id),
      provider: opencodeProviderConfig(all),
      model: input.agent.model,
      autoupdate: false,
      share: 'disabled',
      permission: opencodePermission({ perms: opts.perms, roleKey: opts.roleKey, chat: opts.chat }),
      // the repository's own AGENTS.md is read as the other runtimes read theirs (its opencode.json and `.opencode/` are not)
      ...(existsSync(repoAgents) ? { instructions: [repoAgents] } : {}),
    };
    const cmd = buildOpencodeCommand(
      {
        prompt: opts.prompt,
        model: input.agent.model,
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        sessionEnv: this.sessionEnv(input),
        configContent,
        ohome,
      },
      this.cfg,
      this.parentEnv(),
    );
    const routes = all.flatMap((p): EgressRoute[] => {
      const r = opencodeRoute(p);
      if (!r) return [];
      const over = this.host.routeUpstream?.(p.id);
      return [over ? { ...r, upstream: over, allowPrivateUpstream: true } : r];
    });
    const root = this.paths?.root ?? dirname(dirname(input.sandbox.home));
    const script = selfCommand('aom').at(-1);
    const nuget = userNugetPackages(this.realHome());
    const launch: HarnessLaunch = {
      // opencode makes no call of its own besides the model's (its model list, updates, sharing and plugins are off)
      cliHosts: routes.map((r) => new URL(r.upstream).hostname),
      extraHosts: this.cfg.extraAllowedDomains,
      routes,
      ...(this.store?.endpoints().length ? { privateEndpoints: this.store.endpoints() } : {}),
      ...(this.host.proxyTest ? { proxyTest: this.host.proxyTest } : {}),
      sandbox: {
        cwd: input.cwd,
        readOnlyCwd: opts.readOnlyCwd,
        home: input.sandbox.home,
        scratch: input.sandbox.scratch,
        tmp: input.sandbox.tmp,
        ...(input.sandbox.cacheRoot ? { cacheRoot: input.sandbox.cacheRoot } : {}),
        writable: [ohome],
        readonly: [
          ...toolchainReadPaths(
            [...this.cfg.toolchainPaths, ...(input.toolchainReadDirs ?? [])],
            process.execPath,
            this.realHome(),
          ),
          this.paths?.bin ?? join(root, 'bin'),
          ...(script ? [dirname(script)] : []),
          ...opencodeInstallDirs(this.cfg.bin),
          ...(('addDirs' in input ? input.addDirs : []) ?? []),
        ],
        readDirs: input.readDirs ?? [],
        gitDirs: gitCommonDirs(input.cwd),
        mayCommit: opts.mayCommit,
        ...(input.env.AOM_IPC_SOCKET ? { ipcSocket: input.env.AOM_IPC_SOCKET } : {}),
        ...(nuget ? { nugetFallbackDir: nuget } : {}),
        ...(process.platform === 'linux' ? { dotnetShmDir: DOTNET_SHM_DIR } : {}),
      },
      cmd: { bin: cmd.bin, args: cmd.args, env: cmd.env },
    };
    const harness = await (this.host.launch ?? launchInHarnessSandbox)(launch);
    const parser = new OpencodeStreamParser({
      model: input.agent.model,
      chat: opts.chat,
      // a keyless local endpoint costs nothing and spends no key
      ...(used.apiKey ? { key: { source: used.source ?? 'workstation', provider: used.id } } : {}),
    });
    return spawnSession({
      bin: harness.command.bin,
      args: harness.command.args,
      cwd: input.cwd,
      env: harness.command.env,
      inheritEnv: false,
      input: cmd.stdin,
      parseLine: (l) => parser.parseLine(l),
      usage: () => parser.usage(),
      contextTokens: () => parser.contextTokens(),
      ...(input.logFile ? { logFile: input.logFile } : {}),
      exitError: () => (parser.resultError ? `opencode: ${parser.resultError}` : undefined),
      authFailure: (_stderr) => parser.authFailure,
      usageLimit: (stderr) =>
        opencodeUsageLimit(parser.usageLimitText ?? '', this.host.now?.()) ??
        opencodeUsageLimit(stderr, this.host.now?.()),
      onExit: async () => {
        await harness.cleanup();
      },
    });
  }

  async start(input: ShiftStartInput): Promise<RuntimeSession> {
    this.assertRole(input.agent.roleKey, input.agent.isDevops, input.agent.permissions);
    if (input.devopsGuard || input.kind === 'devops' || input.kind === 'ceo')
      throw new Error('runtime_role_refused: DevOps and CEO shifts run on Claude Code');
    const perms = input.agent.permissions;
    const edit = perms.allowedTools.includes('edit');
    return this.run(input, {
      prompt: input.prompt,
      chat: false,
      readOnlyCwd: !edit,
      mayCommit: edit && perms.mayCommit,
      perms,
      roleKey: input.agent.roleKey,
    });
  }

  async startChat(input: ChatStartInput): Promise<RuntimeSession> {
    if (input.agent.isDevops || input.agent.roleKey === 'ceo' || input.agent.roleKey === 'devops')
      throw new Error('runtime_role_refused: the DevOps and CEO chats run on Claude Code');
    if (input.intake)
      throw new Error(
        'runtime_role_refused: the intake chat needs the Jira tool (MCP), which opencode does not get',
      );
    return this.run(input, {
      prompt: input.message,
      chat: true,
      readOnlyCwd: true,
      mayCommit: false,
      perms: input.agent.permissions,
      roleKey: input.agent.roleKey,
    });
  }
}

void writeFileSync;
