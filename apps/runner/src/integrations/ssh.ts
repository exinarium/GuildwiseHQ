import {
  CONNECTABLE_FORGES,
  type ConnectableForge,
  type IntegrationScope,
  type IntegrationState,
  type IntegrationStatus,
} from '@aom/shared';
import { runSshAction, sshInfo } from '../forge/ssh.ts';
import { type AdapterEnv, baseStatus, type IntegrationAdapter, type Outcome } from './types.ts';

/**
 * SSH keys as a status wrapper around the existing `git.ssh` action: the Integrations page shows the public key and the last
 * check; creating and choosing keys stays in Workstations, Git hosts (and `aom-runner git-connect --ssh-key`).
 * Instance: `<provider>@<host>`.
 */
export class SshIntegration implements IntegrationAdapter {
  readonly kind = 'ssh' as const;

  constructor(private readonly env: AdapterEnv) {}

  scopeOf(): IntegrationScope {
    return 'machine';
  }

  private split(instance: string): { provider: ConnectableForge; host: string } | null {
    const [p, h] = instance.split('@');
    if (!p || !h || !(CONNECTABLE_FORGES as readonly string[]).includes(p)) return null;
    return { provider: p as ConnectableForge, host: h };
  }

  async instances(): Promise<string[]> {
    const out: string[] = [];
    for (const [host, s] of this.env.forge.ssh?.settings.all() ?? [])
      if (s.provider) out.push(`${s.provider}@${host}`);
    return out;
  }

  async status(instance: string): Promise<IntegrationStatus> {
    const now = this.env.now();
    const target = this.split(instance);
    if (!target || !this.env.forge.ssh)
      return baseStatus('ssh', instance, 'machine', now, 'unavailable', {
        detail: 'SSH is not available here.',
      });
    const info = sshInfo(this.env.forge.ssh, target.provider, target.host);
    if (!info)
      return baseStatus('ssh', instance, 'machine', now, 'not_connected', {
        detail: 'No SSH key is set up for this host.',
      });
    const check = info.check;
    const state: IntegrationState = !check
      ? 'not_connected'
      : check.state === 'ok'
        ? 'connected'
        : check.state === 'not_authorized' || check.state === 'host_key'
          ? 'refused'
          : check.state === 'unreachable'
            ? 'unreachable'
            : check.state === 'tool_missing'
              ? 'unavailable'
              : 'not_connected';
    return baseStatus('ssh', instance, 'machine', now, state, {
      method: 'ssh',
      ...(info.publicKey ? { publicKey: info.publicKey.slice(0, 1000) } : {}),
      site: target.host,
      ...(check?.detail
        ? { detail: check.detail.slice(0, 400) }
        : !check
          ? { detail: 'Not checked yet. Add the public key to the git host, then use Test.' }
          : {}),
    });
  }

  async test(instance: string): Promise<IntegrationStatus> {
    const target = this.split(instance);
    if (target && this.env.forge.ssh)
      await runSshAction(this.env.exec, this.env.forge.ssh, { ...target, action: 'check' }).catch(
        () => undefined,
      );
    return this.status(instance);
  }

  async remove(instance: string): Promise<Outcome> {
    return {
      error:
        'SSH keys are managed from Workstations, Git hosts (or `aom-runner git-connect <provider> --ssh-key`).',
      code: 'unsupported',
      status: await this.status(instance),
    };
  }
}
