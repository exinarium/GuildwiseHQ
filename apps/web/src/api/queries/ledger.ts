import {
  type CreateLedgerEntryRequest,
  type EditLedgerEntryRequest,
  type LedgerHistoryResponse,
  LedgerHistoryResponseSchema,
  type LedgerListResponse,
  LedgerListResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post, qs } from '../client.ts';

export interface LedgerFilter {
  q?: string;
  projectId?: string;
  scope?: 'all' | 'feature' | 'decision' | 'standing_order';
}

export function useLedger(f: LedgerFilter = {}) {
  const scope = f.scope ?? 'all';
  return useQuery({
    queryKey: ['ledger', f.projectId ?? 'all', scope, f.q ?? ''],
    queryFn: async () =>
      (
        await get<LedgerListResponse>(
          `/ledger${qs({ q: f.q?.trim(), projectId: f.projectId, scope })}`,
          LedgerListResponseSchema,
        )
      ).entries,
  });
}

export function useAddLedgerEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: CreateLedgerEntryRequest) => post('/ledger', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ledger'] }),
  });
}

/** Edits a live standing order in place (backlog #74). */
export function useEditLedgerEntry(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: EditLedgerEntryRequest) => patch(`/ledger/${id}`, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ledger'] }),
  });
}

/** The earlier wordings of an entry, newest first; loaded when the history is opened. */
export function useLedgerHistory(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['ledger', 'history', id],
    enabled,
    queryFn: () => get<LedgerHistoryResponse>(`/ledger/${id}/history`, LedgerHistoryResponseSchema),
  });
}
