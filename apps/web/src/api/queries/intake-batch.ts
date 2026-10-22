import {
  type BatchDto,
  BatchesResponseSchema,
  BatchResponseSchema,
  type CreateBatchRequest,
  CreateBatchResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../client.ts';

/**
 * Batch intake (#63). Lists and details refresh every few seconds while a batch is running (no socket event yet), and
 * are never served from the cache when a page mounts: the app-wide 15 s staleTime kept "Running · 2 queued" on the
 * Intake page while the intakes listed under it (fetched fresh) already showed the cards of both tickets.
 */
export function useBatches() {
  return useQuery({
    queryKey: ['intake-batches'],
    staleTime: 0,
    refetchInterval: (q) => (q.state.data?.some((b) => b.status === 'running') ? 5000 : false),
    queryFn: async () => (await get('/intake/batches', BatchesResponseSchema)).batches,
  });
}

export function useBatch(id: string | undefined) {
  return useQuery({
    queryKey: ['intake-batches', id],
    enabled: !!id,
    staleTime: 0,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 5000 : false),
    queryFn: async () => (await get(`/intake/batches/${id}`, BatchResponseSchema)).batch as BatchDto,
  });
}

export function useCreateBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: CreateBatchRequest) =>
      (await post('/intake/batches', b, CreateBatchResponseSchema)).batch as BatchDto,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['intake-batches'] }),
  });
}

export function useCancelBatch(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await post(`/intake/batches/${id}/cancel`, {}, BatchResponseSchema)).batch,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['intake-batches'] }),
  });
}

export function useRetryBatchItem(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (itemId: string) =>
      (await post(`/intake/batches/${id}/items/${itemId}/retry`, {}, BatchResponseSchema)).batch,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['intake-batches'] }),
  });
}
