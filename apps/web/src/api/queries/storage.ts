import type { StorageConnectionCreate, StorageConnectionDto, StorageRequestDto } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { storageNeedsPolling } from '../../lib/storage.ts';
import { del, get, patch, post } from '../client.ts';

export const storageKey = ['storage'] as const;
const base = '/org/storage';

/** The organization's storage connections (metadata and health only). Also read by the forms builder. */
export function useStorageConnections(enabled = true) {
  return useQuery({
    enabled,
    queryKey: [...storageKey, 'connections'],
    queryFn: async () =>
      (await get<{ connections: StorageConnectionDto[] }>(`${base}/connections`)).connections,
    refetchInterval: (q) => (storageNeedsPolling(q.state.data) ? 5000 : false),
  });
}

export function useCreateStorageConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: StorageConnectionCreate) =>
      post<{ connection: StorageConnectionDto }>(`${base}/connections`, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: storageKey }),
  });
}

export function useRenameStorageConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; label: string }) =>
      patch<{ ok: true }>(`${base}/connections/${v.id}`, { label: v.label }),
    onSuccess: () => qc.invalidateQueries({ queryKey: storageKey }),
  });
}

export function useRemoveStorageConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del<unknown>(`${base}/connections/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: storageKey }),
  });
}

/** Sends a sealed connect. The body is the request id and the envelope: no field value. */
export function useConnectStorage(id: string) {
  return useMutation({
    mutationFn: (b: { requestId: string; envelope: Record<string, unknown> }) =>
      post<{ id: string; state: string }>(`${base}/connections/${id}/connect`, b),
  });
}

/** Starts the sign-in (also the Reconnect action). */
export function useBeginStorageAuth(id: string) {
  return useMutation({
    mutationFn: (b: { siteUrl?: string; baseFolder?: string }) =>
      post<{ sessionId: string }>(`${base}/connections/${id}/auth`, b),
  });
}

export function useCancelStorageAuth(id: string) {
  return useMutation({
    mutationFn: (sid: string) => post<{ ok: true }>(`${base}/connections/${id}/auth/${sid}/cancel`, {}),
  });
}

export function useTestStorage(id: string) {
  return useMutation({
    mutationFn: (requestId: string) => post<{ id: string }>(`${base}/connections/${id}/test`, { requestId }),
  });
}

export const REQUEST_DONE = ['done', 'failed', 'expired', 'cancelled'];

/** Follows one request (a connect, a sign-in or a test) once a second until it ends. */
export function useStorageRequest(rid: string | null) {
  const qc = useQueryClient();
  return useQuery({
    enabled: !!rid,
    queryKey: [...storageKey, 'request', rid],
    queryFn: async () => {
      const r = (await get<{ request: StorageRequestDto }>(`${base}/requests/${rid}`)).request;
      if (REQUEST_DONE.includes(r.state))
        void qc.invalidateQueries({ queryKey: [...storageKey, 'connections'] });
      return r;
    },
    refetchInterval: (q) => (q.state.data && REQUEST_DONE.includes(q.state.data.state) ? false : 1000),
  });
}
