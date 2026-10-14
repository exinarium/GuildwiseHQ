import type {
  GitConnection,
  IntegrationKindId,
  IntegrationScope,
  IntegrationState,
  IntegrationStatus,
  McpAuthState,
} from '@aom/shared';
import type { ProbeResult } from '../adapters/claude-auth.ts';
import type { RunnerConfig } from '../config.ts';
import type { ForgeEnv } from '../forge/types.ts';
import type { PluginMcpServer } from '../mcp/plugins.ts';
import type { RunnerPaths } from '../paths.ts';
import type { Executor } from '../toolchain/exec.ts';
import type { ClaudeCredentialStore } from './claude-store.ts';
import type { LoginSpec } from './session.ts';

/** A connect or remove that did not work: the sentence shown on the page (it never holds a value). */
export interface IntegrationFailure {
  error: string;
  /** `unsupported`, `unavailable`, `refused`, `failed`. */
  code?: string;
  /** The status as it is now, when it is worth showing next to the reason. */
  status?: IntegrationStatus;
}
export type Outcome = IntegrationStatus | IntegrationFailure;
export const isFailure = (o: Outcome): o is IntegrationFailure => 'error' in o;

/** Everything an adapter needs from the machine. Tests inject fakes: nothing here reaches a real provider from a test. */
export interface AdapterEnv {
  paths: RunnerPaths;
  forge: ForgeEnv;
  exec: Executor;
  fetch: typeof fetch;
  /** The runner's config as it is on disk now. */
  config(): RunnerConfig;
  now(): Date;
  /** The user's home (where `.claude` and `.ssh` live). */
  home: string;
  claudeStore: ClaudeCredentialStore;
  claude: {
    bin(): string;
    /** Tests and the mock runtime never start a real Claude Code (nor ask it anything). */
    blocked?(): boolean;
    /** Probes a candidate credential without saving it (an env overlay). */
    probe(env: NodeJS.ProcessEnv): Promise<ProbeResult>;
    /** Probes the login in force, updating the runtime's login state. */
    probeLogin(): Promise<ProbeResult>;
    /** The runtime login state the runner tracks (`expired` pauses work). */
    authState(): 'ok' | 'expired';
    /** After the credential changed: re-probe, mark the runtime available again and report it. */
    afterChange(): Promise<void>;
  };
  mcp: {
    discover(): PluginMcpServer[];
    authOf(): (s: PluginMcpServer) => McpAuthState;
  };
  /** Hosts of the repositories on this workstation, by forge (so a self-managed GitLab shows up as an instance). */
  repoHosts(): Partial<Record<'github' | 'gitlab', string[]>>;
  /** Directory the sign-in CLIs run in (never a repository). */
  sessionCwd: string;
  /** Marks that git/jira state changed, so the legacy reports go out soon. */
  touchRecheck(): void;
}

export interface IntegrationAdapter {
  readonly kind: IntegrationKindId;
  /** Instances known on this workstation (configured hosts, discovered MCP servers, saved tokens). */
  instances(): Promise<string[]>;
  /** Never throws; never returns a secret. */
  status(instance: string): Promise<IntegrationStatus>;
  /** `fields` methods: save only after the provider accepted the values. */
  connect?(instance: string, method: string, fields: Record<string, string>): Promise<Outcome>;
  /** `interactive` methods: the login to drive. */
  begin?(
    instance: string,
    method: string,
    pre: Record<string, string>,
  ): Promise<LoginSpec | IntegrationFailure>;
  /** Re-checks with the provider and returns the fresh status. */
  test(instance: string): Promise<IntegrationStatus>;
  remove(instance: string): Promise<Outcome>;
  /** The scope of this kind for a method (machine-wide logins are limited by the local policy). */
  scopeOf(method?: string): IntegrationScope;
}

export function baseStatus(
  kind: IntegrationKindId,
  instance: string,
  scope: IntegrationScope,
  now: Date,
  state: IntegrationState,
  extra: Partial<IntegrationStatus> = {},
): IntegrationStatus {
  return { kind, instance, scope, state, checkedAt: now.toISOString(), ...extra };
}

/** A git provider's connection (the legacy fact record) as an integration status. */
export function fromGitConnection(
  kind: 'github' | 'gitlab' | 'bitbucket-cloud' | 'azure-devops',
  instance: string,
  scope: IntegrationScope,
  c: GitConnection,
): IntegrationStatus {
  const state: IntegrationState =
    c.state === 'connected'
      ? 'connected'
      : c.state === 'unavailable'
        ? 'unavailable'
        : c.problem === 'token_refused'
          ? 'refused'
          : c.problem === 'unreachable'
            ? 'unreachable'
            : 'not_connected';
  return {
    kind,
    instance,
    scope,
    state,
    checkedAt: c.checkedAt,
    ...(c.method && c.method !== 'ssh'
      ? { method: c.method === 'service-principal' ? 'service_principal' : c.method }
      : {}),
    ...(c.account ? { account: c.account } : {}),
    ...(c.detail ? { detail: c.detail.slice(0, 400) } : {}),
    ...(kind === 'gitlab' || kind === 'azure-devops' ? { site: c.host } : {}),
  };
}

/** The sentence for an error thrown by a provider call: short, never a value. */
export function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);
}
