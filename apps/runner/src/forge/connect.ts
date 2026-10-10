import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { FORGE_LABELS, type ConnectableForge, type GitConnection } from '@aom/shared';
import type { Executor } from '../toolchain/exec.ts';
import { defaultHost, forgeOfKind } from './index.ts';
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

/** The plain-language steps the helper prints (and the DevOps agent can read back to the user). */
export function connectSteps(provider: ConnectableForge, host = defaultHost(provider)): string[] {
  switch (provider) {
    case 'github':
      return [
        `1. Install the GitHub CLI if it is missing: https://cli.github.com`,
        `2. A browser opens: sign in and approve (\`gh auth login --web --hostname ${host}\`).`,
        '3. Pick HTTPS when asked, so git can use the same login (gh sets up the credential helper).',
      ];
    case 'gitlab':
      return [
        '1. Either install the GitLab CLI (https://gitlab.com/gitlab-org/cli) and run `glab auth login`,',
        `   or create a personal access token on ${host} (User settings, Access tokens) with the scopes api and write_repository.`,
        '2. Paste the token when asked. It is kept on this workstation only (secrets/git-tokens.json, mode 0600).',
      ];
    case 'bitbucket-cloud':
      return [
        '1. Create an API token: Bitbucket, Settings, Atlassian account settings, Security, API tokens, "Create API token with scopes" (Bitbucket).',
        '   Scopes: read:repository, write:repository, read:pullrequest, write:pullrequest, read:user.',
        '   (App passwords no longer work: they were switched off on 2026-06-09.)',
        '2. Enter your Atlassian e-mail address and paste the token when asked.',
        '3. Optional SSH instead of https: run this command with --ssh-key, then add the printed public key under Personal Bitbucket settings, SSH keys.',
      ];
    case 'azure-devops':
      return [
        '1. Create a personal access token for your organization: dev.azure.com, User settings, Personal access tokens, scope "Code: Read & write" (and "Project and Team: Read" for the repository list).',
        '   Use an organization-scoped token: global tokens stop working on 2026-12-01.',
        '2. Run this command with --organization <name> and paste the token when asked.',
        '3. Or sign in with the Azure CLI (`az login`): it works without a token.',
      ];
  }
}

export interface SshKeyResult {
  path: string;
  publicKey: string;
  created: boolean;
}

/** Creates `~/.ssh/aom_<provider>` (ed25519, no passphrase) unless it exists; returns the public key to upload. */
export async function ensureSshKey(
  exec: Executor,
  provider: ConnectableForge,
  home = homedir(),
): Promise<SshKeyResult> {
  const dir = join(home, '.ssh');
  const path = join(dir, `aom_${provider.replace(/-/g, '_')}`);
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

/** Where to paste the public key for each provider. */
export function sshUploadHelp(provider: ConnectableForge, host = defaultHost(provider)): string {
  switch (provider) {
    case 'github':
      return `github.com/settings/keys (or https://${host}/settings/keys): New SSH key, paste the public key.`;
    case 'gitlab':
      return `https://${host}/-/user_settings/ssh_keys: paste the public key, Add key.`;
    case 'bitbucket-cloud':
      return 'bitbucket.org: Personal settings, SSH keys, Add key, paste the public key.';
    case 'azure-devops':
      return 'dev.azure.com: User settings, SSH public keys, New Key, paste the public key.';
  }
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
  if (st.state !== 'connected') env.tokens.remove(t.provider, host);
  return st;
}
