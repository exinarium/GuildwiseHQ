import {
  isBusinessOrg,
  type MeResponse,
  type RelayIntegrationCreate,
  RelayIntegrationDtoSchema,
  RelayIntegrationStatusSchema,
  type RelayIntegrationWithUrl,
  RelayIntegrationWithUrlSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { z } from 'zod';
import { mergeRelay, offlineActive, type RelayRow, relayOfflineNotice } from '../../lib/relay.ts';
import { get, post } from '../client.ts';

const ListSchema = z.object({ integrations: z.array(RelayIntegrationDtoSchema) });
const StatusSchema = z.object({ statuses: z.array(RelayIntegrationStatusSchema) });
const RevokeSchema = z.object({ integration: RelayIntegrationDtoSchema });

export const relayKey = ['relay'] as const;
/** The same as `useWorkstations`: never poll faster than the app already does. */
export const RELAY_OFFLINE_POLL_MS = 5000;

/**
 * The org's inbound webhooks merged with their live status (metadata only: never a URL token, never content).
 * Both endpoints answer 403 outside Business mode, so keep it disabled there.
 */
export function useRelayIntegrations(enabled = true) {
  return useQuery({
    enabled,
    queryKey: [...relayKey, 'integrations'],
    queryFn: async (): Promise<RelayRow[]> => {
      const [list, status] = await Promise.all([
        get('/relay/integrations', ListSchema),
        get('/relay/integrations/status', StatusSchema),
      ]);
      return mergeRelay(list.integrations, status.statuses);
    },
    // Serving, going offline and refusals emit no event: poll lightly while an active integration has no runner.
    refetchInterval: (q) => (q.state.data?.some(offlineActive) ? RELAY_OFFLINE_POLL_MS : false),
  });
}

/** The create/rotate answer holds the one-time URL: callers put it in local state and call `reset()` at once. */
export function useCreateRelayIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RelayIntegrationCreate) =>
      post<RelayIntegrationWithUrl>('/relay/integrations', body, RelayIntegrationWithUrlSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: relayKey }),
  });
}

export function useRotateRelayIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      post<RelayIntegrationWithUrl>(`/relay/integrations/${id}/rotate`, {}, RelayIntegrationWithUrlSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: relayKey }),
    onError: () => qc.invalidateQueries({ queryKey: relayKey }),
  });
}

export function useRevokeRelayIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post(`/relay/integrations/${id}/revoke`, {}, RevokeSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: relayKey }),
    onError: () => qc.invalidateQueries({ queryKey: relayKey }),
  });
}

/** The "runner offline, messages waiting at the provider" notice for the shell, or null. */
export function useRelayOfflineNotice(org: MeResponse['activeOrg'] | null | undefined) {
  const q = useRelayIntegrations(!!org && isBusinessOrg(org));
  return useMemo(() => relayOfflineNotice(q.data), [q.data]);
}
