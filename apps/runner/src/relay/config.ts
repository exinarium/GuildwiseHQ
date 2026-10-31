import { RELAY_KINDS, type RelayKind } from '@aom/shared';
import type { RunnerConfig } from '../config.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RelayChange = { ok: true; config: RunnerConfig } | { ok: false; error: string };

/** Serve an integration on this workstation (or change its kind or label). */
export function addRelayIntegration(
  config: RunnerConfig,
  id: string,
  kind: string,
  label?: string,
): RelayChange {
  if (!UUID_RE.test(id)) return { ok: false, error: `'${id}' is not an integration id (a UUID)` };
  if (!(RELAY_KINDS as readonly string[]).includes(kind))
    return { ok: false, error: `'${kind}' is not a kind (${RELAY_KINDS.join(', ')})` };
  const key = id.toLowerCase();
  const rest = config.relay.integrations.filter((i) => i.id.toLowerCase() !== key);
  const entry = { id: key, kind: kind as RelayKind, ...(label ? { label } : {}) };
  return { ok: true, config: { ...config, relay: { ...config.relay, integrations: [...rest, entry] } } };
}

export function removeRelayIntegration(config: RunnerConfig, id: string): RelayChange {
  const key = id.toLowerCase();
  if (!config.relay.integrations.some((i) => i.id.toLowerCase() === key))
    return { ok: false, error: `this workstation does not serve ${id}` };
  return {
    ok: true,
    config: {
      ...config,
      relay: {
        ...config.relay,
        integrations: config.relay.integrations.filter((i) => i.id.toLowerCase() !== key),
      },
    },
  };
}
