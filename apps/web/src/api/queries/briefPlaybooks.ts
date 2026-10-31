import type { BriefPlaybookDto, InstallBriefPlaybookRequest, PatchBriefPlaybookRequest } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post } from '../client.ts';

export const briefPlaybooksKey = ['brief-playbooks'] as const;

/** The ready-made Brief playbooks and the schedule each one is installed as. Business orgs, Owner and Admins only. */
export function useBriefPlaybooks(enabled: boolean) {
  return useQuery({
    queryKey: briefPlaybooksKey,
    queryFn: async () => (await get<{ playbooks: BriefPlaybookDto[] }>('/brief-playbooks')).playbooks,
    enabled,
  });
}

function useAction<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of ['brief-playbooks', 'schedules']) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export const useInstallBriefPlaybook = () =>
  useAction((v: { key: string; body: InstallBriefPlaybookRequest }) =>
    post<{ scheduleId: string; webhookSecret?: string }>(`/brief-playbooks/${v.key}/install`, v.body),
  );

export const usePatchBriefPlaybook = () =>
  useAction((v: { scheduleId: string; body: PatchBriefPlaybookRequest }) =>
    patch<{ webhookSecret?: string }>(`/brief-playbooks/schedules/${v.scheduleId}`, v.body),
  );
