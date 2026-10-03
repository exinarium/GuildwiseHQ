import {
  type CreateLedgerEntryRequest,
  type LedgerListResponse,
  LedgerListResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, qs } from '../client.ts';

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
