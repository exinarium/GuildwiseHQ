import { type ProviderKeyId, sealProviderKey } from '@aom/shared';
import type { RunnerKeys } from '../src/secrets/keys.ts';

/** Seals a workstation key the way the web app does: bound to the provider and endpoint. */
export function sealWs(
  keys: RunnerKeys,
  provider: ProviderKeyId,
  secret: string,
  baseUrl?: string,
  generation = 0,
) {
  return sealProviderKey(keys.publicKey.publicKey, secret, {
    scope: 'workstation',
    provider,
    endpoint: baseUrl,
    generation,
    keyId: keys.publicKey.keyId,
  });
}

/** Seals an organization key the way the web app does: bound to the organization, provider, endpoint and generation. */
export function sealOrg(
  keys: RunnerKeys,
  orgId: string,
  provider: ProviderKeyId,
  secret: string,
  generation = 1,
  baseUrl?: string,
) {
  return sealProviderKey(keys.publicKey.publicKey, secret, {
    scope: 'org',
    orgId,
    provider,
    endpoint: baseUrl,
    generation,
    keyId: keys.publicKey.keyId,
  });
}
