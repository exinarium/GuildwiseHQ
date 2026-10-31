import type { RelayIntegrationDto, RelayIntegrationStatus, RelayKind } from '@aom/shared';

/** An inbound webhook with its live status. `live` is null for a revoked row (the status covers active rows only). */
export type RelayRow = RelayIntegrationDto & { live: RelayIntegrationStatus | null };

export const RELAY_KIND_LABEL: Record<RelayKind, string> = {
  whatsapp_cloud: 'WhatsApp Cloud API',
  form_webhook: 'Form webhook',
  webhook_in: 'Incoming webhook',
  calendar_push: 'Calendar push',
  generic: 'Generic',
};

export const RELAY_OUTCOME_LABEL: Record<string, string> = {
  forwarded: 'forwarded',
  runner_offline: 'runner offline',
  timeout: 'runner too slow',
  rejected_size: 'too large',
  rejected_rate: 'too many requests',
  unknown_path: 'unknown address',
  error: 'error',
};

/** How long a provider keeps retrying a refused message (confirmed for Meta's Cloud API webhooks). */
export const RELAY_RETRY_WINDOW: Partial<Record<RelayKind, string>> = { whatsapp_cloud: 'up to 7 days' };

/** Runner command that binds the Meta app secret and verify token on the workstation (never in the browser). */
export const RELAY_WHATSAPP_CLI = 'guildwise-runner whatsapp-connect';

export const relayServeCommand = (r: Pick<RelayIntegrationDto, 'id' | 'kind'>) =>
  `guildwise-runner relay add ${r.id} --kind ${r.kind}`;

export const relayWhatsAppCommand = (r: Pick<RelayIntegrationDto, 'id'>) => `${RELAY_WHATSAPP_CLI} ${r.id}`;

export function mergeRelay(list: RelayIntegrationDto[], statuses: RelayIntegrationStatus[]): RelayRow[] {
  const byId = new Map(statuses.map((s) => [s.integrationId, s]));
  return list.map((i) => ({ ...i, live: i.status === 'active' ? (byId.get(i.id) ?? null) : null }));
}

/** An active integration that no runner is serving now. */
export const offlineActive = (r: RelayRow): boolean =>
  r.status === 'active' && r.live !== null && !r.live.connected;

export type RelayOfflineNotice = {
  items: { id: string; label: string; kind: RelayKind; since: string; refused: number }[];
  retryText: string;
};

/** Banner rule: active + no serving runner + at least one request refused since it went offline. */
export function relayOfflineNotice(rows: RelayRow[] | undefined): RelayOfflineNotice | null {
  const items = (rows ?? [])
    .filter((r) => offlineActive(r) && (r.live?.refusedSinceOffline.count ?? 0) > 0)
    .map((r) => ({
      id: r.id,
      label: r.label,
      kind: r.kind,
      since: (r.live?.offlineSince ?? r.live?.refusedSinceOffline.lastAt ?? r.createdAt) as string,
      refused: r.live?.refusedSinceOffline.count ?? 0,
    }));
  if (items.length === 0) return null;
  const kinds = new Set(items.map((i) => i.kind));
  const first = items[0]?.kind;
  const window = kinds.size === 1 && first ? RELAY_RETRY_WINDOW[first] : undefined;
  return {
    items,
    retryText: window ? `The provider retries for ${window}.` : 'The provider retries for a limited time.',
  };
}

export type RelayRowState = 'revoked' | 'runner_offline' | 'connected';
/** A row whose status is missing counts as offline for the row text (it gives no banner: no refused count). */
export const relayRowState = (r: RelayRow): RelayRowState =>
  r.status === 'revoked' ? 'revoked' : r.live?.connected ? 'connected' : 'runner_offline';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
