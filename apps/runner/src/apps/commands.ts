import {
  type AppCommandResult,
  type AppConnectPayload,
  CommandPayloadSchemas,
  type IntegrationKindId,
  type RunnerCommandName,
  type SealedEnvelope,
} from '@aom/shared';
import type { AuditEntry } from '../integrations/audit-log.ts';
import type { AutomatedAppIntegration } from '../integrations/automated-app.ts';
import { redact } from '../secrets/redact.ts';

/** Opens a sealed envelope (AAD rebuilt from the outer fields), claims its ref and registers the values for redaction. */
export type OpenEnvelope = (
  envelope: SealedEnvelope,
  outer: { ref: string; kind: IntegrationKindId; instance: string; op: 'connect' },
) =>
  | { ok: true; fields: Record<string, string>; forget: () => void }
  | { ok: false; code: string; message: string };

export interface AppCommandDeps {
  adapter: (provider: string) => AutomatedAppIntegration | undefined;
  open: OpenEnvelope;
  /** The workstation owner's local switch for changes from the web (D8): off refuses an organization connect too. */
  allowWeb: () => boolean;
  audit: (entry: AuditEntry) => void;
  report: () => void;
}

const ALLOW_WEB_OFF =
  'Turned off on this workstation. Run `guildwise-runner integrations allow-web on` there to allow it.';

/**
 * The runner's side of Settings > Automated apps: `app.connect` (a sealed key from the organization Owner), `app.test`,
 * `app.adopt` (register a copy connected from the CLI), `app.remove` and `app.sync`. Answers are facts only: a key or a
 * token never comes back, and a failed connect leaves nothing stored.
 */
export class AppCommands {
  constructor(private readonly deps: AppCommandDeps) {}

  async handle(command: RunnerCommandName, payload: Record<string, unknown>): Promise<AppCommandResult> {
    try {
      switch (command) {
        case 'app.connect':
          return await this.connect(CommandPayloadSchemas['app.connect'].parse(payload));
        case 'app.test': {
          const p = CommandPayloadSchemas['app.test'].parse(payload);
          return await this.test(p.instance);
        }
        case 'app.adopt': {
          const p = CommandPayloadSchemas['app.adopt'].parse(payload);
          const r = await this.test(p.instance);
          if (r.ok)
            this.store(p.instance)?.addRef(p.instance, { orgId: p.orgId, integrationId: p.integrationId });
          return r;
        }
        case 'app.remove': {
          const p = CommandPayloadSchemas['app.remove'].parse(payload);
          return this.remove(p.instance, { orgId: p.orgId, integrationId: p.integrationId });
        }
        case 'app.sync':
          return this.sync(CommandPayloadSchemas['app.sync'].parse(payload));
        default:
          return {
            ok: false,
            code: 'unexpected',
            message: 'This command is not supported by this runner version.',
          };
      }
    } catch (err) {
      return {
        ok: false,
        code: 'unexpected',
        message: redact(err instanceof Error ? err.message : String(err)).slice(0, 300),
      };
    }
  }

  private adapterOf(instance: string): AutomatedAppIntegration | undefined {
    const any = this.deps.adapter('github-app');
    const app = any?.broker().store.get(instance);
    return app ? this.deps.adapter(app.provider) : any;
  }

  private store(instance: string) {
    return this.adapterOf(instance)?.broker().store;
  }

  private async connect(p: AppConnectPayload): Promise<AppCommandResult> {
    const instance = p.installationId ? `${p.appRef}:${p.installationId}` : p.appRef;
    const entry = {
      kind: p.provider,
      instance,
      op: 'connect' as const,
      method: 'app_key',
      via: 'web' as const,
    };
    const adapter = this.deps.adapter(p.provider);
    if (!adapter) {
      this.deps.audit({ ...entry, result: 'refused', detail: 'unsupported' });
      return {
        ok: false,
        code: 'runner_too_old',
        message: 'This runner does not support this app provider.',
      };
    }
    if (!this.deps.allowWeb()) {
      this.deps.audit({ ...entry, result: 'refused', detail: 'allow_web_off' });
      return { ok: false, code: 'unexpected', message: ALLOW_WEB_OFF };
    }
    const opened = this.deps.open(p.envelope, { ref: p.ref, kind: p.provider, instance, op: 'connect' });
    if (!opened.ok) {
      this.deps.audit({ ...entry, result: 'refused', detail: opened.code });
      return { ok: false, code: 'unexpected', message: opened.message.slice(0, 300) };
    }
    try {
      const r = await adapter.connectApp(
        {
          host: p.host,
          appRef: p.appRef,
          ...(p.installationId ? { installationId: p.installationId } : {}),
          privateKey: opened.fields.privateKey ?? '',
        },
        {
          ref: { orgId: p.orgId, integrationId: p.integrationId ?? p.requestId },
          ...(p.expect ? { expect: p.expect } : {}),
        },
      );
      this.deps.audit({
        ...entry,
        result: r.ok ? 'ok' : 'failed',
        ...(r.ok ? {} : { detail: r.code ?? 'unexpected' }),
      });
      if (r.ok) this.deps.report();
      return r;
    } finally {
      // Stored: the key store keeps the key registered. Not stored: connectApp already unregistered its own copy.
      opened.forget();
    }
  }

  private async test(instance: string): Promise<AppCommandResult> {
    const adapter = this.adapterOf(instance);
    if (!adapter) return { ok: false, instance, code: 'installation_not_found' };
    const r = await adapter.verifyStored(instance);
    this.deps.audit({
      kind: adapter.kind,
      instance,
      op: 'test',
      via: 'web',
      result: r.ok ? 'ok' : 'failed',
      ...(r.ok ? {} : { detail: r.code ?? 'unexpected' }),
    });
    this.deps.report();
    return r;
  }

  /** Drops one organization's use of the copy; the key is deleted when nobody uses it and it was not connected locally. */
  private async remove(
    instance: string,
    ref: { orgId: string; integrationId: string },
  ): Promise<AppCommandResult> {
    const adapter = this.adapterOf(instance);
    const info = adapter?.broker().store.dropRef(instance, ref);
    if (adapter && info && info.refs.length === 0 && !info.local) {
      await adapter.remove(instance);
      this.deps.audit({ kind: adapter.kind, instance, op: 'remove', via: 'web', result: 'ok' });
    }
    this.deps.report();
    return { ok: true, instance };
  }

  /** Drops the refs of the listed organizations that the server no longer has (a removal made while offline). */
  private async sync(p: {
    orgIds: string[];
    apps: Array<{ orgId: string; integrationId: string; instance: string }>;
  }): Promise<AppCommandResult> {
    const adapter = this.deps.adapter('github-app');
    if (!adapter) return { ok: true };
    const store = adapter.broker().store;
    const orgs = new Set(p.orgIds);
    const keep = new Set(p.apps.map((a) => `${a.instance}|${a.orgId}|${a.integrationId}`));
    for (const app of store.list())
      for (const ref of app.refs)
        if (orgs.has(ref.orgId) && !keep.has(`${app.instance}|${ref.orgId}|${ref.integrationId}`))
          await this.remove(app.instance, ref);
    return { ok: true };
  }
}
