import type { SessionTimeAction } from '@aom/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { del, post } from '../client.ts';

/** Archive (read-only) or reopen a session. */
export function useArchiveSession(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (arg: boolean | { archived: boolean; endFirst?: boolean }) =>
      post(`/sessions/${id}/archive`, typeof arg === 'boolean' ? { archived: arg } : arg),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['discovery', id] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

/** Delete a session (a tombstone: it disappears from lists and queries). */
export function useDeleteSession(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => del(`/sessions/${id}`),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ['discovery', id] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export type TimeActionBody = SessionTimeAction;
