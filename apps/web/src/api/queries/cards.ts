import {
  type CardDetailResponse,
  CardDetailResponseSchema,
  type CreateCardRequest,
  type PatchCardRequest,
  SpecifyMissingResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, patch, post } from '../client.ts';

export function useCard(ref: string | undefined) {
  return useQuery({
    queryKey: ['card', ref],
    enabled: !!ref,
    refetchInterval: 30_000,
    queryFn: () =>
      get<CardDetailResponse>(`/cards/${encodeURIComponent(ref ?? '')}`, CardDetailResponseSchema),
  });
}

/** Missing field keys carried by a 422 `missing_fields` error (empty when the error is something else). */
export function missingFromError(e: unknown): string[] {
  if (e instanceof ApiError && e.status === 422) {
    const parsed = SpecifyMissingResponseSchema.safeParse({
      error: { code: e.code, message: e.message, details: e.details },
    });
    if (parsed.success) return parsed.data.error.details.missing;
  }
  return [];
}

export function useCreateCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: CreateCardRequest) =>
      post<{ card: CardDetailResponse['card']; missing?: string[] }>('/cards', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board'] }),
  });
}

function useCardAction<V>(cardId: string, fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['card'] });
      qc.invalidateQueries({ queryKey: ['board'] });
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
    meta: { cardId },
  });
}

export const useSpecifyCard = (id: string) => useCardAction(id, () => post(`/cards/${id}/specify`));
export const usePatchCard = (id: string) =>
  useCardAction(id, (b: PatchCardRequest) => patch(`/cards/${id}`, b));
export const useComment = (id: string) =>
  useCardAction(id, (body: string) => post(`/cards/${id}/comments`, { body }));
export const useMoveCard = (id: string) =>
  useCardAction(id, (b: { toStage: string; reason: string }) =>
    post<{ moveNotice?: string }>(`/cards/${id}/move`, b),
  );
export const useReopenCard = (id: string) =>
  useCardAction(id, (b: { toStage: string; reason: string }) => post(`/cards/${id}/reopen`, b));
export const useReleaseCard = (id: string) =>
  useCardAction(id, (reason?: string) => post(`/cards/${id}/release`, reason ? { reason } : {}));
export const useReleaseBackoff = (id: string) =>
  useCardAction(id, (reason?: string) => post(`/cards/${id}/release-backoff`, reason ? { reason } : {}));
export const useCancelCard = (id: string) =>
  useCardAction(id, (b: { reason: string; alsoCancelChildren?: boolean }) =>
    post(`/cards/${id}/cancel`, b.alsoCancelChildren ? b : { reason: b.reason }),
  );
