import type { DeployRunDto, ReleaseQueueItem } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, post } from '../client.ts';
import { queueKey, runsKey } from './delivery.ts';

/**
 * Data of the Releases page and of the rollback sheet (docs/design/environments-ux.md sections 5.5, 4 K and 9 gaps 6, 7, 11).
 * Each read falls back to what the older endpoints tell when the newer one is missing (404) or refuses a member (403).
 */

export type LiveHealth = 'healthy' | 'unhealthy' | 'unknown' | 'updating';
export type LiveRole = 'test' | 'live' | 'other';

export interface LiveRow {
  projectId: string;
  projectKey: string;
  projectName: string;
  env: string;
  /** "Test site", "Live site". */
  label: string;
  role: LiveRole;
  version: string | null;
  commit: string | null;
  since: string | null;
  health: LiveHealth;
  placeName: string | null;
  appUrl: string | null;
  /** How many releases wait for this environment. */
  waitingRelease: number;
}

export const liveKey = ['org-live'] as const;

const roleOfEnv = (env: string): LiveRole =>
  /prod|live/i.test(env) ? 'live' : /uat|test|stag/i.test(env) ? 'test' : 'other';
const labelOf = (role: LiveRole, env: string) =>
  role === 'live' ? 'Live site' : role === 'test' ? 'Test site' : env;

/** Rows built from the deploy runs and the release queue (older servers). */
export function liveRowsFromRuns(runs: DeployRunDto[], queue: ReleaseQueueItem[]): LiveRow[] {
  const real = runs.filter((r) => !r.dryRun && !r.trial);
  const keys = new Map<string, { projectId: string; projectKey: string; env: string }>();
  for (const r of real)
    keys.set(`${r.projectId}|${r.env}`, { projectId: r.projectId, projectKey: r.projectKey, env: r.env });
  for (const q of queue)
    keys.set(`${q.projectId}|${q.env}`, { projectId: q.projectId, projectKey: q.projectKey, env: q.env });
  return [...keys.values()]
    .map(({ projectId, projectKey, env }) => {
      const list = real
        .filter((r) => r.projectId === projectId && r.env === env)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const ok = list.find((r) => r.status === 'succeeded');
      const last = list[0];
      const role = roleOfEnv(env);
      return {
        projectId,
        projectKey,
        projectName: projectKey,
        env,
        label: labelOf(role, env),
        role,
        version: ok ? ((ok.deployedCommit ?? ok.commit)?.slice(0, 7) ?? null) : null,
        commit: ok?.deployedCommit ?? ok?.commit ?? null,
        since: ok?.finishedAt ?? null,
        health: !last
          ? 'unknown'
          : last.status === 'running' || last.status === 'queued'
            ? 'updating'
            : last.status === 'succeeded'
              ? 'healthy'
              : 'unhealthy',
        placeName: ok?.targetName ?? last?.targetName ?? null,
        appUrl: ok?.url ?? null,
        waitingRelease: queue.filter((q) => q.projectId === projectId && q.env === env).length,
      } satisfies LiveRow;
    })
    .sort(
      (a, b) =>
        a.projectKey.localeCompare(b.projectKey) || Number(b.role === 'live') - Number(a.role === 'live'),
    );
}

/** What is live, for every project the viewer can see. Members may read it. */
export function useOrgLive() {
  return useQuery({
    queryKey: liveKey,
    refetchInterval: 30_000,
    retry: false,
    queryFn: async (): Promise<LiveRow[]> => {
      try {
        return (await get<{ rows: LiveRow[] }>('/org/live')).rows ?? [];
      } catch (e) {
        if (!(e instanceof ApiError) || ![404, 403].includes(e.status)) throw e;
      }
      const [runs, queue] = await Promise.all([
        get<{ runs: DeployRunDto[] }>('/delivery/runs?limit=60').catch(() => ({
          runs: [] as DeployRunDto[],
        })),
        get<{ items: ReleaseQueueItem[] }>('/delivery/queue').catch(() => ({
          items: [] as ReleaseQueueItem[],
        })),
      ]);
      return liveRowsFromRuns(runs.runs, queue.items);
    },
  });
}

export interface RollbackCandidate {
  commit: string;
  version: string | null;
  at: string;
  releasedBy: string | null;
  /** Where the backup taken before the newer release is kept. */
  backupPath: string | null;
}

export function useRollbackCandidates(projectId: string, env: string) {
  return useQuery({
    queryKey: ['rollback-candidates', projectId, env],
    retry: false,
    queryFn: async (): Promise<RollbackCandidate[]> => {
      try {
        return (
          (
            await get<{ candidates: RollbackCandidate[] }>(
              `/projects/${projectId}/environments/${encodeURIComponent(env)}/rollback-candidates`,
            )
          ).candidates ?? []
        );
      } catch (e) {
        if (!(e instanceof ApiError) || ![404, 403].includes(e.status)) throw e;
      }
      const { runs } = await get<{ runs: DeployRunDto[] }>('/delivery/runs?limit=60');
      return runs
        .filter(
          (r) =>
            r.projectId === projectId && r.env === env && r.status === 'succeeded' && !r.dryRun && !r.trial,
        )
        .sort((a, b) => ((a.finishedAt ?? a.createdAt) < (b.finishedAt ?? b.createdAt) ? 1 : -1))
        .slice(0, 5)
        .map((r) => ({
          commit: r.deployedCommit ?? r.commit ?? '',
          version: (r.deployedCommit ?? r.commit)?.slice(0, 7) ?? null,
          at: r.finishedAt ?? r.createdAt,
          releasedBy: r.releasedBy?.name ?? null,
          backupPath: null,
        }));
    },
  });
}

/** `POST /api/projects/:id/releases {env, commit, kind: 'rollback'}`: Owner or Admin, audited, no test-site rule. */
export function useRollback(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { env: string; commit: string }) =>
      post<{ message?: string }>(`/projects/${projectId}/releases`, { ...v, kind: 'rollback' }),
    onSuccess: () => {
      for (const k of [liveKey, queueKey, runsKey, ['env-status', projectId], ['delivery', projectId]])
        void qc.invalidateQueries({ queryKey: k });
    },
  });
}
