import { join } from 'node:path';
import {
  CommandPayloadSchemas,
  checkIntegrationRequest,
  INTEGRATIONS_REGISTRY_VERSION,
  type IntegrationBeginPayload,
  type IntegrationCommandResult,
  type IntegrationConnectPayload,
  type IntegrationInputPayload,
  type IntegrationKindId,
  type IntegrationRequestPayload,
  type IntegrationSessionMsg,
  type IntegrationStatus,
  type IntegrationsPolicy,
  integrationKind,
  integrationMethod,
  MAX_INTEGRATION_STATUSES,
  type RunnerCommandName,
  type SealedPlaintext,
} from '@aom/shared';
import { type Logger, nullLogger } from '../log.ts';
import { EnvelopeError, type RunnerKeys } from '../secrets/keys.ts';
import { redact, registerSecret, unregisterSecret } from '../secrets/redact.ts';
import { type AuditEntry, AuditLog } from './audit-log.ts';
import { ClaudeCodeIntegration } from './claude-code.ts';
import { AzureDevOpsIntegration, BitbucketIntegration, GitLabIntegration } from './forge-tokens.ts';
import { GitHubIntegration } from './github.ts';
import { JiraIntegration } from './jira.ts';
import { LoginRuntimeIntegration } from './login-runtimes.ts';
import { McpIntegration } from './mcp.ts';
import type { LoginSpawner } from './pty.ts';
import { ReplayCache } from './seen.ts';
import { LoginSession } from './session.ts';
import { SshIntegration } from './ssh.ts';
import {
  type AdapterEnv,
  type IntegrationAdapter,
  type IntegrationFailure,
  isFailure,
  type Outcome,
} from './types.ts';

export { AuditLog } from './audit-log.ts';
export { ReplayCache } from './seen.ts';
export type { AdapterEnv, IntegrationAdapter } from './types.ts';

/** Sessions a workstation may run at once. */
export const MAX_SESSIONS = 2;

export function buildIntegrationAdapters(
  env: AdapterEnv,
  opts: { jiraFetch?: (url: string, init: RequestInit) => Promise<Response> } = {},
): Map<IntegrationKindId, IntegrationAdapter> {
  const list: IntegrationAdapter[] = [
    new ClaudeCodeIntegration(env),
    new LoginRuntimeIntegration('codex', env),
    new LoginRuntimeIntegration('gemini', env),
    new GitHubIntegration(env),
    new GitLabIntegration(env),
    new BitbucketIntegration(env),
    new AzureDevOpsIntegration(env),
    new SshIntegration(env),
    new JiraIntegration(env, opts.jiraFetch ? { fetch: opts.jiraFetch } : {}),
    new McpIntegration(env),
  ];
  return new Map(list.map((a) => [a.kind, a]));
}

export interface IntegrationServiceDeps {
  workstationId: string;
  keys: RunnerKeys;
  env: AdapterEnv;
  adapters?: Map<IntegrationKindId, IntegrationAdapter>;
  /** This pairing may change machine-wide logins from the web (default true: a single pairing is the primary one). */
  isPrimary?: () => boolean;
  send(type: 'integrations.report' | 'integration.session', payload: Record<string, unknown>): void;
  spawn?: LoginSpawner;
  log?: Logger;
  now?: () => number;
  sessionLimitMs?: number;
}

type Entry = Omit<AuditEntry, 'result' | 'detail'>;

const REFUSED = {
  allowWebOff:
    'Turned off on this workstation. Run `guildwise-runner integrations allow-web on` there to allow it.',
  machineScope: (primary: string) =>
    `This sign-in is shared by every pairing on this machine. Connect it from ${primary} or from a terminal on the workstation.`,
};

/**
 * The runner's side of the Integrations page (docs/design/integrations-page.md). Holds one adapter per kind, opens the
 * sealed envelopes the manager relays, drives interactive sign-ins, enforces the local policy (D8), keeps the local audit
 * log and sends `integrations.report`. Nothing here sends, logs or returns a secret.
 */
export class IntegrationService {
  readonly adapters: Map<IntegrationKindId, IntegrationAdapter>;
  private readonly seen: ReplayCache;
  private readonly audit: AuditLog;
  private readonly sessions = new Map<string, LoginSession>();
  private lastReport: string | undefined;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly deps: IntegrationServiceDeps) {
    this.adapters = deps.adapters ?? buildIntegrationAdapters(deps.env);
    this.now = deps.now ?? Date.now;
    this.seen = new ReplayCache(join(deps.env.paths.secrets, 'integration-seen.json'), this.now);
    this.audit = new AuditLog(join(deps.env.paths.logs, 'integrations.jsonl'), () => new Date(this.now()));
    this.log = deps.log ?? nullLogger;
  }

  // -------------------------------------------------------------------------------------------- policy

  policy(): IntegrationsPolicy {
    const p = this.deps.env.config().integrations;
    return {
      allowWeb: p.allowWeb,
      machineScopeFromWeb: p.machineScopeFromWeb,
      primaryPairing: this.deps.isPrimary?.() ?? true,
    };
  }

  /** Why a web change is refused, or null. `machine`: the change touches a login shared by every pairing. */
  private refusal(machine: boolean): IntegrationCommandResult | null {
    const p = this.policy();
    if (!p.allowWeb) return { error: REFUSED.allowWebOff, code: 'allow_web_off' };
    if (machine && (p.machineScopeFromWeb === 'never' || !p.primaryPairing))
      return {
        error: REFUSED.machineScope(
          p.machineScopeFromWeb === 'never'
            ? 'a terminal on this workstation'
            : "the machine's primary pairing",
        ),
        code: 'machine_scope',
      };
    return null;
  }

  // -------------------------------------------------------------------------------------------- report

  /** Every integration of this workstation, one fact record each. Never throws. */
  async statuses(): Promise<IntegrationStatus[]> {
    const out: IntegrationStatus[] = [];
    await Promise.all(
      [...this.adapters.values()].map(async (a) => {
        let instances: string[] = [];
        try {
          instances = await a.instances();
        } catch (err) {
          this.log.warn(`integrations: ${a.kind} instances failed: ${String(err)}`);
        }
        const found = await Promise.all(instances.map((i) => this.safeStatus(a, i)));
        out.push(...found);
      }),
    );
    out.sort((x, y) => x.kind.localeCompare(y.kind) || x.instance.localeCompare(y.instance));
    return out.slice(0, MAX_INTEGRATION_STATUSES);
  }

  private async safeStatus(a: IntegrationAdapter, instance: string): Promise<IntegrationStatus> {
    try {
      return this.clean(await a.status(instance));
    } catch (err) {
      return {
        kind: a.kind,
        instance,
        scope: a.scopeOf(),
        state: 'unreachable',
        checkedAt: new Date(this.now()).toISOString(),
        detail: redact(err instanceof Error ? err.message : String(err)).slice(0, 300),
      };
    }
  }

  private clean(s: IntegrationStatus): IntegrationStatus {
    return s.detail ? { ...s, detail: redact(s.detail).slice(0, 400) } : s;
  }

  /** Sends `integrations.report` when something changed since the last one (or when forced). */
  async report(force = false): Promise<void> {
    const statuses = await this.statuses();
    const policy = this.policy();
    const key = JSON.stringify([statuses.map(({ checkedAt: _c, ...s }) => s), policy]);
    if (!force && key === this.lastReport) return;
    this.lastReport = key;
    this.deps.send('integrations.report', {
      integrations: statuses,
      registryVersion: INTEGRATIONS_REGISTRY_VERSION,
      policy,
    });
  }

  // -------------------------------------------------------------------------------------------- commands

  /** Handles one `integration.*` command. The answer is a status or a sentence; a secret never comes back. */
  async handle(
    command: RunnerCommandName,
    payload: Record<string, unknown>,
  ): Promise<IntegrationCommandResult> {
    try {
      switch (command) {
        case 'integration.connect':
          return await this.connect(CommandPayloadSchemas['integration.connect'].parse(payload));
        case 'integration.begin':
          return await this.begin(CommandPayloadSchemas['integration.begin'].parse(payload));
        case 'integration.input':
          return this.input(CommandPayloadSchemas['integration.input'].parse(payload));
        case 'integration.cancel':
          this.sessions.get(CommandPayloadSchemas['integration.cancel'].parse(payload).sessionId)?.cancel();
          return { accepted: true };
        case 'integration.test':
          return await this.test(CommandPayloadSchemas['integration.test'].parse(payload));
        case 'integration.remove':
          return await this.remove(CommandPayloadSchemas['integration.remove'].parse(payload));
        default:
          return { error: 'This command is not supported by this runner version.', code: 'unsupported' };
      }
    } catch (err) {
      return {
        error: redact(err instanceof Error ? err.message : String(err)).slice(0, 300),
        code: 'failed',
      };
    }
  }

  private adapterFor(kind: IntegrationKindId): IntegrationAdapter | undefined {
    return this.adapters.get(kind);
  }

  /** Opens an envelope for `outer`, claims its ref, and registers the fields for redaction. */
  private open(
    envelope: Parameters<RunnerKeys['open']>[0],
    outer: Omit<Parameters<RunnerKeys['open']>[1], 'workstationId'>,
  ): { ok: true; plain: SealedPlaintext } | { ok: false; result: IntegrationCommandResult } {
    let plain: SealedPlaintext;
    try {
      plain = this.deps.keys.open(envelope, { ...outer, workstationId: this.deps.workstationId }, this.now());
    } catch (err) {
      if (err instanceof EnvelopeError)
        return { ok: false, result: { error: err.message, code: err.code === 'key' ? 'key' : err.code } };
      throw err;
    }
    if (!this.seen.claim(plain.ref, plain.exp))
      return {
        ok: false,
        result: { error: 'These values were already used: enter them again.', code: 'replayed' },
      };
    for (const v of Object.values(plain.fields)) registerSecret(v);
    return { ok: true, plain };
  }

  private forget(plain: SealedPlaintext): void {
    for (const v of Object.values(plain.fields)) unregisterSecret(v);
  }

  private done(entry: Entry, out: Outcome): IntegrationCommandResult {
    if (isFailure(out)) {
      this.audit.write({
        ...entry,
        result: out.code === 'refused' ? 'refused' : 'failed',
        detail: out.error,
      });
      return {
        error: redact(out.error).slice(0, 400),
        ...(out.code ? { code: out.code } : {}),
        ...(out.status ? { status: this.clean(out.status) } : {}),
      };
    }
    this.audit.write({ ...entry, result: 'ok' });
    return { status: this.clean(out) };
  }

  private async connect(p: IntegrationConnectPayload): Promise<IntegrationCommandResult> {
    const entry = {
      kind: p.kind,
      instance: p.instance,
      op: 'connect' as const,
      method: p.method,
      via: 'web' as const,
    };
    const bad = checkIntegrationRequest(p.kind, p.instance, p.method, 'fields');
    if (bad) return this.done(entry, { error: bad, code: 'unsupported' });
    const adapter = this.adapterFor(p.kind);
    if (!adapter?.connect)
      return this.done(entry, {
        error: 'This integration cannot be connected from the web.',
        code: 'unsupported',
      });
    const refused = this.refusal(adapter.scopeOf(p.method) === 'machine');
    if (refused) {
      this.audit.write({ ...entry, result: 'refused', detail: refused.code ?? '' });
      return refused;
    }
    const opened = this.open(p.envelope, {
      ref: p.requestId,
      kind: p.kind,
      instance: p.instance,
      op: 'connect',
    });
    if (!opened.ok) {
      this.audit.write({ ...entry, result: 'refused', detail: opened.result.code ?? '' });
      return opened.result;
    }
    try {
      const m = integrationMethod(
        integrationKind(p.kind) as NonNullable<ReturnType<typeof integrationKind>>,
        p.method,
      );
      const allowed = new Set((m?.fields ?? []).map((f) => f.key));
      const fields = Object.fromEntries(Object.entries(opened.plain.fields).filter(([k]) => allowed.has(k)));
      const out = await adapter.connect(p.instance, p.method, fields);
      const result = this.done(entry, out);
      void this.report(true);
      return result;
    } finally {
      this.forget(opened.plain);
    }
  }

  private async begin(p: IntegrationBeginPayload): Promise<IntegrationCommandResult> {
    const entry = {
      kind: p.kind,
      instance: p.instance,
      op: 'session' as const,
      method: p.method,
      via: 'web' as const,
    };
    const bad = checkIntegrationRequest(p.kind, p.instance, p.method, 'interactive');
    if (bad) return this.done(entry, { error: bad, code: 'unsupported' });
    const adapter = this.adapterFor(p.kind);
    if (!adapter?.begin)
      return this.done(entry, { error: 'This sign-in cannot be started from the web.', code: 'unsupported' });
    const refused = this.refusal(adapter.scopeOf(p.method) === 'machine');
    if (refused) {
      this.audit.write({ ...entry, result: 'refused', detail: refused.code ?? '' });
      return refused;
    }
    const live = [...this.sessions.values()].filter((s) => !s.terminal);
    if (live.some((s) => s.kind === p.kind && s.instance === p.instance))
      return this.done(entry, {
        error: 'A sign-in for this is already running. Cancel it first.',
        code: 'busy',
      });
    if (live.length >= MAX_SESSIONS)
      return this.done(entry, {
        error: 'Two sign-ins are already running on this workstation. Finish one first.',
        code: 'busy',
      });
    const spec = await adapter.begin(p.instance, p.method, p.pre ?? {});
    if ('error' in spec) return this.done(entry, spec as IntegrationFailure);
    const session = new LoginSession(
      p.sessionId,
      p.kind,
      p.instance,
      spec,
      this.deps.spawn ?? (await import('./pty.ts')).spawnLoginProcess,
      (m) => this.emitSession(m),
      this.deps.sessionLimitMs ? { limitMs: this.deps.sessionLimitMs } : {},
    );
    this.sessions.set(p.sessionId, session);
    void session.ended.then(() => {
      const st = session.state;
      this.audit.write({
        ...entry,
        result: st === 'connected' ? 'ok' : st === 'cancelled' ? 'refused' : 'failed',
        detail: st,
      });
      void this.report(true);
      setTimeout(() => this.sessions.delete(p.sessionId), 60_000).unref();
    });
    session.start();
    this.audit.write({ ...entry, result: 'ok', detail: 'started' });
    return { accepted: true };
  }

  private emitSession(m: IntegrationSessionMsg): void {
    const safe: IntegrationSessionMsg = {
      ...m,
      ...(m.error ? { error: redact(m.error).slice(0, 300) } : {}),
      ...(m.status ? { status: this.clean(m.status) } : {}),
    };
    this.deps.send('integration.session', safe as unknown as Record<string, unknown>);
  }

  private input(p: IntegrationInputPayload): IntegrationCommandResult {
    const entry = { kind: p.kind, instance: p.instance, op: 'input' as const, via: 'web' as const };
    const refused = this.refusal(false);
    if (refused) return refused;
    const session = this.sessions.get(p.sessionId);
    if (!session || session.terminal || session.kind !== p.kind || session.instance !== p.instance)
      return { error: 'This sign-in is no longer running. Start it again.', code: 'expired' };
    // The browser seals each paste with ref `<sessionId>:<attempt>`; the first three attempts are tried.
    let opened: ReturnType<IntegrationService['open']> | undefined;
    for (const ref of [`${p.sessionId}:1`, `${p.sessionId}:2`, `${p.sessionId}:3`]) {
      let plain: SealedPlaintext | undefined;
      try {
        plain = this.deps.keys.open(
          p.envelope,
          { workstationId: this.deps.workstationId, ref, kind: p.kind, instance: p.instance, op: 'input' },
          this.now(),
        );
      } catch (err) {
        if (err instanceof EnvelopeError && err.code === 'key') return { error: err.message, code: 'key' };
        if (err instanceof EnvelopeError && err.code === 'expired')
          return { error: err.message, code: 'expired' };
        continue;
      }
      if (!this.seen.claim(plain.ref, plain.exp))
        return { error: 'These values were already used: paste again.', code: 'replayed' };
      opened = { ok: true, plain };
      break;
    }
    if (!opened || !opened.ok)
      return { error: 'The pasted value could not be opened: paste it again.', code: 'decrypt' };
    const value = opened.plain.fields.value ?? opened.plain.fields.code ?? opened.plain.fields.url ?? '';
    const r = session.input(value);
    this.audit.write({ ...entry, result: r.accepted ? 'ok' : 'refused', detail: r.accepted ? '' : r.reason });
    return r.accepted ? { accepted: true } : { error: r.reason, code: 'busy' };
  }

  private async test(p: IntegrationRequestPayload): Promise<IntegrationCommandResult> {
    const entry = { kind: p.kind, instance: p.instance, op: 'test' as const, via: 'web' as const };
    const adapter = this.adapterFor(p.kind);
    if (!adapter) return this.done(entry, { error: 'Unknown integration.', code: 'unsupported' });
    const status = await this.safeTest(adapter, p.instance);
    this.audit.write({ ...entry, result: 'ok', detail: status.state });
    void this.report(true);
    return { status };
  }

  private async safeTest(a: IntegrationAdapter, instance: string): Promise<IntegrationStatus> {
    try {
      return this.clean(await a.test(instance));
    } catch (err) {
      return {
        kind: a.kind,
        instance,
        scope: a.scopeOf(),
        state: 'unreachable',
        checkedAt: new Date(this.now()).toISOString(),
        detail: redact(err instanceof Error ? err.message : String(err)).slice(0, 300),
      };
    }
  }

  private async remove(p: IntegrationRequestPayload): Promise<IntegrationCommandResult> {
    const entry = { kind: p.kind, instance: p.instance, op: 'remove' as const, via: 'web' as const };
    const adapter = this.adapterFor(p.kind);
    if (!adapter) return this.done(entry, { error: 'Unknown integration.', code: 'unsupported' });
    const refused = this.refusal(adapter.scopeOf() === 'machine');
    if (refused) {
      this.audit.write({ ...entry, result: 'refused', detail: refused.code ?? '' });
      return refused;
    }
    const out = await adapter.remove(p.instance);
    const result = this.done(entry, out);
    void this.report(true);
    return result;
  }

  /** Ends every sign-in (the runner stops). */
  stop(): void {
    for (const s of this.sessions.values()) s.cancel();
  }
}
