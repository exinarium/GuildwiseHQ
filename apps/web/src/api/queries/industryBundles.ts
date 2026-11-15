import {
  type IndustryBundleInstallResult,
  IndustryBundleInstallResultSchema,
  IndustryBundleListResponseSchema,
  type IndustryBundlePreview,
  IndustryBundlePreviewSchema,
  type IndustryBundleRemoveResult,
  IndustryBundleRemoveResultSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, qs } from '../client.ts';

const BASE = '/industry-bundles';
export const industryBundlesKey = ['industry-bundles'] as const;

/** Industry bundles (business mode): the list, a preview, install and uninstall. */
export function useIndustryBundles(enabled = true) {
  return useQuery({
    queryKey: industryBundlesKey,
    enabled,
    queryFn: async () => (await get(BASE, IndustryBundleListResponseSchema)).bundles ?? [],
  });
}

/** `projectId`: the project chosen for the playbook cards; the preview's blockers depend on it. */
export function useIndustryBundlePreview(id: string | null, projectId?: string) {
  return useQuery({
    queryKey: [...industryBundlesKey, id, projectId ?? null],
    enabled: !!id,
    queryFn: () =>
      get<IndustryBundlePreview>(`${BASE}/${id}${qs({ projectId })}`, IndustryBundlePreviewSchema),
  });
}

// Where bundle members show: rules (ledger, rule packs), playbooks (brief playbooks, schedules), knowledge
// templates and sample data (documents). Journey templates are static, so they have no key.
const AFFECTED = [
  industryBundlesKey,
  ['rule-packs'],
  ['ledger'],
  ['brief-playbooks'],
  ['schedules'],
  ['documents'],
] as const;

function useAfterBundleChange() {
  const qc = useQueryClient();
  return () => {
    for (const k of AFFECTED) void qc.invalidateQueries({ queryKey: k });
  };
}

export function useInstallIndustryBundle() {
  const after = useAfterBundleChange();
  return useMutation({
    mutationFn: ({ id, projectId }: { id: string; projectId?: string }) =>
      post<IndustryBundleInstallResult>(
        `${BASE}/${id}/install`,
        projectId ? { projectId } : {},
        IndustryBundleInstallResultSchema,
      ),
    onSuccess: after,
  });
}

export function useRemoveIndustryBundle() {
  const after = useAfterBundleChange();
  return useMutation({
    mutationFn: (id: string) =>
      post<IndustryBundleRemoveResult>(`${BASE}/${id}/remove`, {}, IndustryBundleRemoveResultSchema),
    onSuccess: after,
  });
}
