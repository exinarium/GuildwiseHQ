import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type ConnectableForge, defaultHost, FORGE_LABELS, type GitConnection } from '@aom/shared';

export { connectSteps, sshUploadHelp } from '@aom/shared';

import type { Executor } from '../toolchain/exec.ts';
import { forgeOfKind } from './index.ts';
import type { ForgeEnv } from './types.ts';

/** The file `aom-runner git-connect` touches so a running runner reports the new status without a restart. */
export const recheckFile = (secretsDir: string): string => join(secretsDir, 'git-recheck');

export function touchRecheck(secretsDir: string): void {
  const f = recheckFile(secretsDir);
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  if (!existsSync(f)) writeFileSync(f, '');
  const now = new Date();
  utimesSync(f, now, now);
}

export interface SshKeyResult {
  path: string;
  publicKey: string;
  created: boolean;
}

/** `~/.ssh/aom_<provider>`: the private key file the runner generates for a provider. */
export function sshKeyPathFor(provider: ConnectableForge, home = homedir()): string {
  return join(home, '.ssh', `aom_${provider.replace(/-/g, '_')}`);
}

/** Creates `~/.ssh/aom_<provider>` (ed25519, no passphrase) unless it exists; returns the public key to upload. */
export async function ensureSshKey(
  exec: Executor,
  provider: ConnectableForge,
  home = homedir(),
): Promise<SshKeyResult> {
  const dir = join(home, '.ssh');
  const path = sshKeyPathFor(provider, home);
  let created = false;
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const r = await exec.run(
      'ssh-keygen',
      ['-t', 'ed25519', '-N', '', '-C', `guildwise-${provider}`, '-f', path],
      { timeoutMs: 30_000 },
    );
    if (r.exitCode !== 0) throw new Error(`ssh-keygen failed: ${(r.stderr || r.stdout).trim()}`);
    created = true;
  }
  return { path, publicKey: readFileSync(`${path}.pub`, 'utf8').trim(), created };
}

export function describeConnection(c: GitConnection): string {
  const label = FORGE_LABELS[c.provider];
  const who = c.account ? ` as ${c.account}` : '';
  return c.state === 'connected'
    ? `${label} (${c.host}): connected${who}`
    : `${label} (${c.host}): ${c.state === 'unavailable' ? 'tool missing' : 'not connected'}${c.detail ? `. ${c.detail}` : ''}`;
}

/** Saves a token (after the caller checked it works) and returns the resulting status. Never prints the token. */
export async function saveAndVerify(
  env: ForgeEnv,
  t: { provider: ConnectableForge; host?: string; token: string; user?: string; organization?: string },
): Promise<GitConnection> {
  const host = t.host ?? defaultHost(t.provider);
  env.tokens.set({
    provider: t.provider,
    host,
    token: t.token,
    ...(t.user ? { user: t.user } : {}),
    ...(t.organization ? { organization: t.organization } : {}),
  });
  const forge = forgeOfKind(env, t.provider, host, t.organization);
  const st = await (forge.status as () => Promise<GitConnection>)();
  if (st.state !== 'connected') env.tokens.remove(t.provider, host, t.organization);
  return st;
}
