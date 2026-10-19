import {
  type AuthorizeStandingOrderRequest,
  type CreateLedgerEntryRequest,
  type EditLedgerEntryRequest,
  type LedgerHistoryResponse,
  LedgerHistoryResponseSchema,
  type LedgerListResponse,
  LedgerListResponseSchema,
  type RetireLedgerEntryRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post, qs } from '../client.ts';

export interface LedgerFilter {
  q?: string;
  projectId?: string;
  scope?: 'all' | 'feature' | 'decision' | 'standing_order';
  /** Also list retired entries (shown greyed out). */
  includeRetired?: boolean;
}

export function useLedger(f: LedgerFilter = {}) {
  const scope = f.scope ?? 'all';
  return useQuery({
    queryKey: ['ledger', f.projectId ?? 'all', scope, f.q ?? '', f.includeRetired ? 'retired' : 'live'],
    queryFn: async () =>
      (
        await get<LedgerListResponse>(
          `/ledger${qs({ q: f.q?.trim(), projectId: f.projectId, scope, includeRetired: f.includeRetired ? 'true' : undefined })}`,
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

/** Withdraws an entry with a reason: it is kept for the record, never briefed and never found by a search. */
export function useRetireLedgerEntry(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: RetireLedgerEntryRequest) => post(`/ledger/${id}/retire`, b),
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

/** The Owner marks a standing order "the CEO enforces this with full power" (pinned to the wording he saw). */
export function useAuthorizeOrder(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: AuthorizeStandingOrderRequest) => post(`/ledger/${id}/authorize`, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ledger'] }),
  });
}

export function useRevokeOrderAuthority(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post(`/ledger/${id}/revoke`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ledger'] }),
  });
}

/** An Admin asks the Owner to take an order over as his own. */
export function useEscalateOrder(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (note: string) => post(`/ledger/${id}/escalate`, { note }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ledger'] }),
  });
}
