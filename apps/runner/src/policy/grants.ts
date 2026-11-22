import { normalizeRemoteUrl, urlHasPassword } from '@aom/shared';
import type { HeldRecord } from './held.ts';
import type { PasskeyOfferRecord } from './passkey-store.ts';
import type { Policy } from './schema.ts';

/**
 * The pure operations on the local policy (easy-runner-setup): each takes a policy and returns the changed copy. The CLI
 * (`policy/cli.ts`, which keeps its terminal prompts), `setup` and the approvals page (`window/api.ts`, which may call
 * only its fixed allowlist [S1]) all write through these, and every write goes through `PolicyStore.update` (validated,
 * temp file plus rename, mode 600). Nothing here reads or writes a file.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SHA256_RE = /^[0-9a-f]{64}$/;

export function devopsGrant(p: Policy, orgId: string, agentId: string): Policy {
  return { ...p, devops: { ...p.devops, agents: { ...p.devops.agents, [orgId]: agentId } } };
}

export function devopsRevoke(p: Policy, orgId: string): Policy {
  const agents = { ...p.devops.agents };
  delete agents[orgId];
  return { ...p, devops: { ...p.devops, agents } };
}

export function devopsInstall(p: Policy, on: boolean): Policy {
  return { ...p, devopsInstall: on };
}

export function devopsRequests(p: Policy, mode: 'ask' | 'auto'): Policy {
  return { ...p, devopsRequests: mode };
}

export function devopsAgentRequests(p: Policy, mode: 'ask' | 'deny'): Policy {
  return { ...p, devopsAgentRequests: mode };
}

/** The key `installScripts` uses for a repository: the normalized remote (github.com/owner/repo). */
export const repoScriptsKey = (url: string): string => normalizeRemoteUrl(url.trim());

export function repoScripts(p: Policy, url: string, allow: boolean): Policy {
  if (urlHasPassword(url)) throw new Error('a repository address with a password is refused');
  const key = repoScriptsKey(url);
  const installScripts = { ...p.installScripts };
  if (allow) installScripts[key] = true;
  else delete installScripts[key];
  return { ...p, installScripts };
}

export function formatterPin(p: Policy, hash: string, add: boolean): Policy {
  return {
    ...p,
    formatterPins: add ? [...new Set([...p.formatterPins, hash])] : p.formatterPins.filter((h) => h !== hash),
  };
}

export function deployMode(p: Policy, mode: 'ask' | 'off'): Policy {
  return { ...p, deploy: mode };
}

export function deployPinCommit(p: Policy, on: boolean): Policy {
  return { ...p, deployPinCommit: on };
}

export function deployUnpin(p: Policy, hashOrAll: string): Policy {
  return { ...p, deployPins: hashOrAll === 'all' ? [] : p.deployPins.filter((h) => h !== hashOrAll) };
}

/** `approve --pin`: the held deploy's whole-command hash, and with `deployPinCommit` the commit-bound one. */
export function deployPinHeld(p: Policy, pin: NonNullable<HeldRecord['pin']>): Policy {
  const add = [pin.base, ...(p.deployPinCommit && pin.bound ? [pin.bound] : [])];
  return { ...p, deployPins: [...new Set([...p.deployPins, ...add])] };
}

export function unsignedOrigin(p: Policy, origin: string, allow: boolean): Policy {
  return {
    ...p,
    allowUnsignedUpdatesFrom: allow
      ? [...new Set([...p.allowUnsignedUpdatesFrom, origin])]
      : p.allowUnsignedUpdatesFrom.filter((o) => o !== origin),
  };
}

/** Trusts one passkey the server offered (the caller removes the offer afterwards). */
export function passkeyTrust(p: Policy, o: PasskeyOfferRecord, now: number = Date.now()): Policy {
  return {
    ...p,
    passkeys: [
      ...p.passkeys.filter((k) => k.credentialId !== o.credentialId),
      {
        credentialId: o.credentialId,
        publicKey: o.publicKey,
        alg: o.alg,
        rpId: o.rpId,
        origin: new URL(o.origin).origin,
        name: o.name,
        trustedAt: new Date(now).toISOString(),
        signCount: 0,
      },
    ],
  };
}

/** Removes every trusted passkey whose credential id starts with `prefix` (the CLI takes a prefix). */
export function passkeyRemove(p: Policy, prefix: string): Policy {
  return { ...p, passkeys: p.passkeys.filter((k) => !k.credentialId.startsWith(prefix)) };
}

/** Removes the one trusted passkey with exactly this credential id (the approvals page). */
export function passkeyRemoveId(p: Policy, credentialId: string): Policy {
  return { ...p, passkeys: p.passkeys.filter((k) => k.credentialId !== credentialId) };
}

export function signingAddKey(p: Policy, key: { keyId: string; keyFile: string; autoSign: boolean }): Policy {
  return { ...p, signingKeys: [...p.signingKeys.filter((k) => k.keyId !== key.keyId), key] };
}

export function signingRemoveKey(p: Policy, keyId: string): Policy {
  return { ...p, signingKeys: p.signingKeys.filter((k) => k.keyId !== keyId.toUpperCase()) };
}
