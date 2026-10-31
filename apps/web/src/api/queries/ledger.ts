import {
  type AuthorizeStandingOrderRequest,
  type CreateLedgerEntryRequest,
  type EditLedgerEntryRequest,
  type LedgerHistoryResponse,
  LedgerHistoryResponseSchema,
  type LedgerListResponse,
  LedgerListResponseSchema,
  type RetireLedgerEntryRequest,
  type ReviewLedgerEntryRequest,
  type RulePackInstallResult,
  RulePackInstallResultSchema,
  type RulePackListResponse,
  RulePackListResponseSchema,
  type RulePackPreview,
  RulePackPreviewSchema,
  type RulePackRemoveResult,
  RulePackRemoveResultSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post, qs } from '../client.ts';

export interface LedgerFilter {
  q?: string;
  projectId?: string;
  scope?: 'all' | 'feature' | 'decision' | 'standing_order';
  /** Also list retired entries (shown greyed out). */
  includeRetired?: boolean;
  /** Only entries that are due for review. */
  due?: boolean;
}

export function useLedger(f: LedgerFilter = {}) {
  const scope = f.scope ?? 'all';
  return useQuery({
    queryKey: [
      'ledger',
      f.projectId ?? 'all',
      scope,
      f.q ?? '',
      f.includeRetired ? 'retired' : 'live',
      f.due ? 'due' : 'any',
    ],
    queryFn: async () =>
      (
        await get<LedgerListResponse>(
          `/ledger${qs({ q: f.q?.trim(), projectId: f.projectId, scope, includeRetired: f.includeRetired ? 'true' : undefined, due: f.due ? 'true' : undefined })}`,
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

/** The owner confirms a due entry at a review: it stays, with a later review date or none. */
export function useReviewLedgerEntry(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: ReviewLedgerEntryRequest) => post(`/ledger/${id}/review`, b),
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

/** Rule packs (business mode): the list, a preview, install and remove. */
export function useRulePacks(enabled = true) {
  return useQuery({
    queryKey: ['rule-packs'],
    enabled,
    queryFn: async () =>
      (await get<RulePackListResponse>('/ledger/rule-packs', RulePackListResponseSchema)).packs,
  });
}

export function useRulePackPreview(packId: string | null) {
  return useQuery({
    queryKey: ['rule-packs', packId],
    enabled: !!packId,
    queryFn: () => get<RulePackPreview>(`/ledger/rule-packs/${packId}`, RulePackPreviewSchema),
  });
}

export function useInstallRulePack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (packId: string) =>
      post<RulePackInstallResult>(`/ledger/rule-packs/${packId}/install`, {}, RulePackInstallResultSchema),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ledger'] });
      qc.invalidateQueries({ queryKey: ['rule-packs'] });
    },
  });
}

export function useRemoveRulePack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (packId: string) =>
      post<RulePackRemoveResult>(`/ledger/rule-packs/${packId}/remove`, {}, RulePackRemoveResultSchema),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ledger'] });
      qc.invalidateQueries({ queryKey: ['rule-packs'] });
    },
  });
}
