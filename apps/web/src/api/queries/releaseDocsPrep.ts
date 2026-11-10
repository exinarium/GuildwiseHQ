import {
  type ReleaseDocsPrepOverviewItem,
  ReleaseDocsPrepOverviewItemSchema,
  type ReleaseDocsPrepSettingsDto,
  ReleaseDocsPrepSettingsDtoSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { get, post, put } from '../client.ts';

/** Release prep (docs and videos): the switch of a project and the checklist of registered steps. */
export function useReleaseDocsPrepSettings(projectId: string | undefined) {
  return useQuery({
    enabled: !!projectId,
    queryKey: ['release-docs-prep', 'settings', projectId],
    queryFn: () =>
      get<ReleaseDocsPrepSettingsDto>(
        `/projects/${projectId}/release-docs-prep/settings`,
        ReleaseDocsPrepSettingsDtoSchema,
      ),
  });
}

export function useSaveReleaseDocsPrepSettings(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      enabled: boolean;
      steps: Record<string, boolean>;
      guidePaths?: Record<string, string>;
      autoStart?: boolean;
    }) =>
      put<ReleaseDocsPrepSettingsDto>(
        `/projects/${projectId}/release-docs-prep/settings`,
        v,
        ReleaseDocsPrepSettingsDtoSchema,
      ),
    onSuccess: (data) => {
      qc.setQueryData(['release-docs-prep', 'settings', projectId], data);
      void qc.invalidateQueries({ queryKey: ['release-docs-prep'] });
    },
  });
}

/** The projects that use release prep (switch on, or a run exists). Empty: the Releases tab is not shown. */
export function useReleaseDocsPrepOverview() {
  return useQuery({
    queryKey: ['release-docs-prep', 'overview'],
    queryFn: () =>
      get<ReleaseDocsPrepOverviewItem[]>('/release-docs-prep', z.array(ReleaseDocsPrepOverviewItemSchema)),
    retry: false,
  });
}

const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ queryKey: ['release-docs-prep'] });

export function useRunReleaseDocsPrep(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<{ runId: string }>(`/projects/${projectId}/release-docs-prep/runs`),
    onSuccess: () => invalidate(qc),
  });
}

export function useRetryReleaseDocsPrep(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      post<{ runId: string }>(`/projects/${projectId}/release-docs-prep/runs/${runId}/retry`),
    onSuccess: () => invalidate(qc),
  });
}

export function useSkipReleaseDocsPrep(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<void>(`/projects/${projectId}/release-docs-prep/skip`),
    onSuccess: () => invalidate(qc),
  });
}
