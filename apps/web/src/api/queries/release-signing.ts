import type { ReleaseSigningState, ReleaseSigningStatus } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../client.ts';

/**
 * Release signing per deploy target (R30): where each target of an environment stands for the release of a commit, and
 * the actions of the release sheet (package the runner for a target, sign it on the workstation holding the key, upload
 * an offline signature). The secret key never passes through here.
 */
export const releaseSigningKey = (projectId: string, env: string, commit: string | null) =>
  ['release-signing', projectId, env, commit] as const;

/** States that change by themselves on the workstation: the sheet asks again until they settle. */
const MOVING: ReadonlySet<ReleaseSigningState> = new Set(['preparing', 'signing']);

export function useReleaseSigning(projectId: string, env: string, commit: string | null, enabled = true) {
  return useQuery({
    enabled: enabled && !!commit,
    queryKey: releaseSigningKey(projectId, env, commit),
    retry: false,
    queryFn: async () => {
      const q = new URLSearchParams({ env, ...(commit ? { commit } : {}) });
      const s = await get<ReleaseSigningStatus>(`/projects/${projectId}/release-signing?${q}`);
      // an answer without targets (an older server) means nothing to sign
      return { ...s, targets: Array.isArray(s?.targets) ? s.targets : [] } as ReleaseSigningStatus;
    },
    refetchInterval: (query) => (query.state.data?.targets.some((t) => MOVING.has(t.state)) ? 4000 : false),
  });
}

export function manifestUrl(projectId: string, releaseId: string, targetId: string): string {
  return `/api/projects/${projectId}/release-signing/manifest?${new URLSearchParams({ releaseId, targetId })}`;
}

function useSigningMutation<B>(projectId: string, path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: B) => post<unknown>(`/projects/${projectId}/release-signing/${path}`, body),
    onSettled: () => qc.invalidateQueries({ queryKey: ['release-signing', projectId] }),
  });
}

export const usePrepareRelease = (projectId: string) =>
  useSigningMutation<{ targetId: string; commit: string }>(projectId, 'prepare');
export const useSignOnWorkstation = (projectId: string) =>
  useSigningMutation<{ releaseId: string; targetId: string }>(projectId, 'sign');
export const useUploadSignature = (projectId: string) =>
  useSigningMutation<{ releaseId: string; targetId: string; minisig: string; artefactSha256?: string }>(
    projectId,
    'signature',
  );
