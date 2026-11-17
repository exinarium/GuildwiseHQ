import type {
  DeliverySettingsResponse,
  DeployCommitPreview,
  DeployRequest,
  DeployResult,
  DeployRunDto,
  GateBindingDto,
  GatePresetDto,
  ReleaseQueueItem,
  SetDeploySecretRequest,
  SetGateBindingRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCanManageOrg } from '../../lib/orgRole.ts';
import { countOpenShipReleases, countWaitingReleases } from '../../lib/releaseCounts.ts';
import { encryptForRunner } from '../../lib/runner-seal.ts';
import { ApiError, del, get, post, put } from '../client.ts';
import { useDesk } from './desk.ts';

/**
 * Delivery recipes, the release queue and the deploy runs (docs/design/ceo-front-door.md section 9 and 14.2). The recipe lives in
 * the project vault; approving it is the Owner's button; releasing is the Owner's or an Admin's.
 */
export const deliveryKey = (projectId: string) => ['delivery', projectId] as const;
export const queueKey = ['delivery-queue'] as const;
export const runsKey = ['delivery-runs'] as const;
export const gatesKey = ['delivery-gates'] as const;

export function useDelivery(projectId: string) {
  return useQuery({
    queryKey: deliveryKey(projectId),
    queryFn: () => get<DeliverySettingsResponse>(`/projects/${projectId}/delivery`),
    retry: false,
  });
}

function useDeliveryMutation<V, R>(projectId: string, fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: deliveryKey(projectId) });
      void qc.invalidateQueries({ queryKey: queueKey });
      void qc.invalidateQueries({ queryKey: runsKey });
      void qc.invalidateQueries({ queryKey: ['desk'] });
      void qc.invalidateQueries({ queryKey: ['deploy-setup', projectId] });
      void qc.invalidateQueries({ queryKey: ['env-status', projectId] });
    },
  });
}

export const useSetDeliveryMode = (projectId: string) =>
  useDeliveryMutation(projectId, (mode: 'instructions' | 'recipe') =>
    put<DeliverySettingsResponse>(`/projects/${projectId}/delivery/mode`, { mode }),
  );

/** Asks a workstation to read `delivery/` of the project vault again. */
export const useInspectRecipe = (projectId: string) =>
  useDeliveryMutation(projectId, () =>
    post<{ queued: boolean; reason?: string }>(`/projects/${projectId}/delivery/inspect`, {}),
  );

/** The Owner approves exactly the hash he saw. */
export const useApproveRecipe = (projectId: string) =>
  useDeliveryMutation(projectId, (hash: string) =>
    post<DeliverySettingsResponse>(`/projects/${projectId}/delivery/approve`, { hash }),
  );

export const useRejectRecipe = (projectId: string) =>
  useDeliveryMutation(projectId, (v: { hash: string; reason?: string }) =>
    post<DeliverySettingsResponse>(`/projects/${projectId}/delivery/reject`, v),
  );

/** The Deploy button: the same server path as `aom deploy run`, from the Owner's or an Admin's session. */
export const useDeploy = (projectId: string) =>
  useDeliveryMutation(projectId, (v: DeployRequest) =>
    post<DeployResult>(`/projects/${projectId}/delivery/deploy`, v),
  );

export const deployPreviewKey = (projectId: string, env: string, commit: string | null) =>
  ['deploy-preview', projectId, env, commit] as const;

/**
 * The commit a deploy of `env` would build, resolved by the server with the same code as the deploy itself. Without `commit`
 * it is the server's default; with one, that commit or the server's error.
 */
export function useDeployPreview(projectId: string, env: string, commit: string | null, enabled = true) {
  return useQuery({
    enabled,
    queryKey: deployPreviewKey(projectId, env, commit),
    retry: false,
    staleTime: 0,
    queryFn: async () => {
      const q = new URLSearchParams({ env, ...(commit ? { commit } : {}) });
      try {
        const p = await get<DeployCommitPreview>(`/projects/${projectId}/delivery/deploy/preview?${q}`);
        // Never let an owner confirm on an answer that does not name a commit.
        if (!p || typeof p.sha !== 'string' || !p.sha)
          throw new Error('The server did not say which commit it would build.');
        return p;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'validation_error')
          throw new ApiError(
            e.status,
            e.code,
            'That is not a commit SHA: use 7 to 40 characters 0-9 and a-f.',
          );
        throw e;
      }
    },
  });
}

/** One recipe secret, encrypted in the browser for the runner of the chosen workstation: only ciphertext is sent. */
export const useSetDeploySecret = (projectId: string) =>
  useDeliveryMutation(projectId, async (v: { workstationId: string; name: string; value: string }) => {
    const key = await get<{ keyId: string; publicKey: string }>(`/workstations/${v.workstationId}/sudo-key`);
    const body: SetDeploySecretRequest = {
      projectId,
      name: v.name,
      keyId: key.keyId,
      ciphertext: await encryptForRunner(key.publicKey, v.value),
    };
    return put<{ queued: boolean }>(`/workstations/${v.workstationId}/deploy-secrets`, body);
  });

export function useReleaseQueue(enabled = true) {
  return useQuery({
    queryKey: queueKey,
    enabled,
    refetchInterval: 15_000,
    queryFn: async () => (await get<{ items?: ReleaseQueueItem[] }>('/delivery/queue')).items ?? [],
  });
}

/**
 * The Releases badge: the waiting rows of the release queue (Owner/Admin only; nobody else makes the request) plus the open Ship
 * release desk items. It reads the same cached queries as the Releases page and the Desk, so their invalidation updates it too.
 */
export function useReleaseBadgeCounts(enabled = true) {
  const manage = useCanManageOrg();
  const queue = useReleaseQueue(enabled && manage);
  const desk = useDesk();
  const waiting = enabled && manage ? countWaitingReleases(queue.data) : 0;
  const ship = enabled ? countOpenShipReleases(desk.data?.items) : 0;
  return { waiting, ship, total: waiting + ship };
}

function useQueueMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queueKey });
      void qc.invalidateQueries({ queryKey: runsKey });
      void qc.invalidateQueries({ queryKey: ['delivery'] });
      void qc.invalidateQueries({ queryKey: ['desk'] });
    },
  });
}

/** Release: the runs the Owner or Admin chose (one per server). */
export const useRelease = () =>
  useQueueMutation((runIds: string[]) => post<DeployResult>('/delivery/release', { runIds }));
export const useCancelRelease = () =>
  useQueueMutation((runId: string) => post(`/delivery/runs/${runId}/cancel`, {}));

export function useDeployRuns(enabled = true) {
  return useQuery({
    queryKey: runsKey,
    enabled,
    refetchInterval: 10_000,
    queryFn: async () => (await get<{ runs: DeployRunDto[] }>('/delivery/runs?limit=60')).runs,
  });
}

export function useGates(enabled = true) {
  return useQuery({
    queryKey: gatesKey,
    enabled,
    queryFn: () => get<{ presets: GatePresetDto[]; bindings: GateBindingDto[] }>('/delivery/gates'),
  });
}

function useGateMutation<V>(fn: (v: V) => Promise<{ presets: GatePresetDto[]; bindings: GateBindingDto[] }>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => qc.setQueryData(gatesKey, data),
  });
}

export const useSetPreset = () =>
  useGateMutation((v: { name: string; gate: GatePresetDto['gate'] }) => put('/delivery/presets', v));
export const useRemovePreset = () =>
  useGateMutation((name: string) =>
    del<{ presets: GatePresetDto[]; bindings: GateBindingDto[] }>(
      `/delivery/presets/${encodeURIComponent(name)}`,
    ),
  );
export const useSetBinding = () =>
  useGateMutation((v: SetGateBindingRequest) => put('/delivery/bindings', v));
