import { type SetupChecklist, SetupChecklistSchema } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../client.ts';

export const setupKey = ['setup-checklist'] as const;

/**
 * The "Get started" checklist of the active organization. The steps are computed on the server from real state, so
 * the list is simply refetched now and then (on focus, after a navigation, every minute).
 */
export function useSetupChecklist(enabled = true) {
  return useQuery({
    queryKey: setupKey,
    queryFn: () => get('/setup-checklist', SetupChecklistSchema),
    enabled,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

/** Hides (`dismissed: true`) or reopens the checklist for this user. */
export function useSetChecklistDismissed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dismissed: boolean) => put('/setup-checklist', { dismissed }, SetupChecklistSchema),
    onMutate: (dismissed) => {
      qc.setQueryData<SetupChecklist | undefined>(setupKey, (c) => (c ? { ...c, dismissed } : c));
    },
    onSuccess: (c) => qc.setQueryData(setupKey, c),
    onError: () => qc.invalidateQueries({ queryKey: setupKey }),
  });
}
