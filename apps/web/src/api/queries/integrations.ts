import {
  type IntegrationActionRequest,
  type IntegrationConnectRequest,
  type IntegrationRequestAccepted,
  type IntegrationRequestDto,
  type IntegrationSessionRequest,
  IntegrationWorkstationsResponseSchema,
  type SealedEnvelope,
  type WorkstationIntegrationsResponse,
  WorkstationIntegrationsResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { z } from 'zod';
import { ApiError, get, post } from '../client.ts';

/*
 * The Integrations page (docs/design/integrations-page.md). Secret values never pass through this file: the caller seals
 * them (lib/runner-seal.ts) and hands over the envelope, so no mutation variable, query key or cache entry holds one.
 */

type IntegrationWorkstationsResponse = z.infer<typeof IntegrationWorkstationsResponseSchema>;

const key = (id: string) => ['integrations', 'workstation', id] as const;

/** The chooser: the user's workstations with their needs-attention counts. */
export function useIntegrationWorkstations() {
  return useQuery({
    queryKey: ['integrations', 'workstations'],
    queryFn: () =>
      get<IntegrationWorkstationsResponse>(
        '/integrations/workstations',
        IntegrationWorkstationsResponseSchema,
      ),
  });
}

/** One workstation's integrations: statuses, the runner's key, its policy and any live sign-in session. */
export function useWorkstationIntegrations(id: string | undefined) {
  return useQuery({
    queryKey: key(id ?? ''),
    enabled: !!id,
    queryFn: () =>
      get<WorkstationIntegrationsResponse>(
        `/workstations/${id}/integrations`,
        WorkstationIntegrationsResponseSchema,
      ),
    refetchInterval: 15_000,
  });
}

export function useRefreshIntegrations(id: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: key(id) });
    void qc.invalidateQueries({ queryKey: ['integrations', 'workstations'] });
  };
}

const base = (id: string) => `/workstations/${id}/integrations`;

/** Sends a sealed connect. The body is the request id, the target and the envelope: no field value. */
export function useConnectIntegration(workstationId: string) {
  return useMutation({
    mutationFn: (b: IntegrationConnectRequest) =>
      post<IntegrationRequestAccepted>(`${base(workstationId)}/connect`, b),
  });
}

export function useBeginIntegrationSession(workstationId: string) {
  return useMutation({
    mutationFn: (b: IntegrationSessionRequest) =>
      post<IntegrationRequestAccepted>(`${base(workstationId)}/sessions`, b),
  });
}

/** The paste step: the envelope (sealed with op 'input', ref `${sessionId}:${attempt}`) is the only thing sent. */
export function useSendSessionInput(workstationId: string, sessionId: string) {
  return useMutation({
    mutationFn: (envelope: SealedEnvelope) =>
      post<IntegrationRequestAccepted>(`${base(workstationId)}/sessions/${sessionId}/input`, { envelope }),
  });
}

export function useCancelIntegrationSession(workstationId: string, sessionId: string) {
  return useMutation({
    mutationFn: () =>
      post<IntegrationRequestAccepted>(`${base(workstationId)}/sessions/${sessionId}/cancel`, {}),
  });
}

export function useTestIntegration(workstationId: string) {
  return useMutation({
    mutationFn: (b: IntegrationActionRequest) =>
      post<IntegrationRequestAccepted>(`${base(workstationId)}/test`, b),
  });
}

export function useRemoveIntegration(workstationId: string) {
  return useMutation({
    mutationFn: (b: IntegrationActionRequest) =>
      post<IntegrationRequestAccepted>(`${base(workstationId)}/remove`, b),
  });
}

export const REQUEST_TERMINAL = ['done', 'failed', 'expired', 'cancelled', 'connected'];
export const isRequestTerminal = (state: string | undefined): boolean =>
  !!state && REQUEST_TERMINAL.includes(state);

/** Polls one request or session every second until it ends; refetches the page when it succeeded. */
export function useIntegrationRequest(workstationId: string, requestId: string | null) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['integrations', 'request', requestId],
    enabled: !!requestId,
    queryFn: () => get<IntegrationRequestDto>(`${base(workstationId)}/requests/${requestId}`),
    refetchInterval: (query) => (isRequestTerminal(query.state.data?.state) ? false : 1000),
    gcTime: 0,
  });
  const state = q.data?.state;
  useEffect(() => {
    if (state === 'done' || state === 'connected') {
      void qc.invalidateQueries({ queryKey: key(workstationId) });
      void qc.invalidateQueries({ queryKey: ['integrations', 'workstations'] });
    }
  }, [state, qc, workstationId]);
  return q;
}

/** What to tell the user for the errors the integration routes give. */
export function integrationErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'workstation_offline':
        return 'The workstation is offline. Start its runner and try again.';
      case 'runner_key_changed':
        return "The workstation's key changed. The page was reloaded; try again.";
      case 'runner_too_old':
        return 'This runner is too old to do that from here. Update it, or use the terminal command.';
      case 'session_busy':
        return 'A sign-in for this is already running. Finish or cancel it first.';
      default:
        if (e.status === 404) return 'This workstation was not found, or it is not yours.';
        return e.message;
    }
  }
  return e instanceof Error ? e.message : 'Something went wrong';
}
