import type { ProposalDto, ReleaseQueueItem } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, del, get, post } from '../client.ts';
import { queueKey, runsKey } from './delivery.ts';
import { setupKey } from './deploy-setup.ts';

/**
 * The thin API layer of the Environments page (docs/design/environments-ux.md sections 9 and 13). Every read falls back to
 * what the existing endpoints already tell (the setup state, the deploy runs, the release queue) when the newer endpoint is
 * not there yet, so the page works against an older server and lights up fully against a newer one.
 */

// ------------------------------------------------------------------------------------------------ status of an environment

export type EnvHealth = 'healthy' | 'unhealthy' | 'unknown' | 'updating';

export interface EnvRelease {
  commit: string;
  version: string | null;
  /** The cards merged since the live version ("from 3 merged cards"). */
  cards: Array<{ ref: string; title: string }>;
  /** Every rule holds now. */
  rulesMet: boolean;
  /** The rules that do not hold yet, in plain words ("test site healthy for 3 more minutes"). */
  waitingFor: string[];
  /** The deploy runs a Release presses (one per place). */
  places: Array<{ runId: string; targetId: string | null; name: string }>;
}

export interface EnvStatusDto {
  env: string;
  version: string | null;
  commit: string | null;
  since: string | null;
  health: EnvHealth;
  appUrl: string | null;
  /** The step an update in flight is at, in words. */
  updatingStep?: string | null;
  lastRun: {
    id: string;
    status: 'succeeded' | 'failed' | 'refused' | 'running' | 'queued';
    at: string;
    summary: string | null;
    failedStep: string | null;
    reason: string | null;
    wentBackTo: string | null;
  } | null;
  waitingRelease: EnvRelease | null;
}

export const statusKey = (projectId: string) => ['env-status', projectId] as const;

/** A short version label for a commit. */
export const shortVersion = (commit: string | null | undefined) => (commit ? commit.slice(0, 7) : null);

export function useEnvStatus(projectId: string | undefined) {
  return useQuery({
    enabled: !!projectId,
    queryKey: statusKey(projectId ?? ''),
    refetchInterval: 15_000,
    retry: false,
    queryFn: async (): Promise<EnvStatusDto[]> => {
      try {
        const d = await get<{ environments: EnvStatusDto[] }>(`/projects/${projectId}/environments/status`);
        return d.environments ?? [];
      } catch (e) {
        if (!(e instanceof ApiError) || ![404, 403].includes(e.status)) throw e;
      }
      // An older server: read what the deploy history and the release queue say.
      const [runs, queue] = await Promise.all([
        get<{ runs: DeployRunLite[] }>('/delivery/runs?limit=60').catch(() => ({ runs: [] })),
        get<{ items: ReleaseQueueItem[] }>('/delivery/queue').catch(() => ({ items: [] })),
      ]);
      return statusFromRuns(projectId ?? '', runs.runs, queue.items);
    },
  });
}

interface DeployRunLite {
  id: string;
  projectId: string;
  env: string;
  status: string;
  commit: string | null;
  deployedCommit: string | null;
  dryRun: boolean;
  trial: boolean;
  summary: string | null;
  refusalDetail: string | null;
  url: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** The fallback: the last real run of each environment, and the queue item waiting for a release. */
export function statusFromRuns(
  projectId: string,
  runs: DeployRunLite[],
  queue: ReleaseQueueItem[],
): EnvStatusDto[] {
  const mine = runs.filter((r) => r.projectId === projectId && !r.dryRun && !r.trial);
  const names = [
    ...new Set([
      ...mine.map((r) => r.env),
      ...queue.filter((q) => q.projectId === projectId).map((q) => q.env),
    ]),
  ];
  return names.map((env) => {
    const list = mine.filter((r) => r.env === env).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const ok = list.find((r) => r.status === 'succeeded');
    const last = list[0];
    const q = queue.find((x) => x.projectId === projectId && x.env === env);
    return {
      env,
      version: shortVersion(ok?.deployedCommit ?? ok?.commit),
      commit: ok?.deployedCommit ?? ok?.commit ?? null,
      since: ok?.finishedAt ?? null,
      health: !last
        ? 'unknown'
        : ['running', 'queued'].includes(last.status)
          ? 'updating'
          : last.status === 'succeeded'
            ? 'healthy'
            : 'unhealthy',
      appUrl: ok?.url ?? null,
      lastRun: last
        ? {
            id: last.id,
            status: (['succeeded', 'failed', 'refused', 'running', 'queued'].includes(last.status)
              ? last.status
              : 'failed') as NonNullable<EnvStatusDto['lastRun']>['status'],
            at: last.finishedAt ?? last.createdAt,
            summary: last.summary,
            failedStep: null,
            reason: last.refusalDetail,
            wentBackTo: null,
          }
        : null,
      waitingRelease: q
        ? {
            commit: q.commit ?? '',
            version: shortVersion(q.commit),
            cards: [],
            rulesMet: q.gateNow.satisfied,
            waitingFor: q.gateNow.missing,
            places: q.targets.map((t) => ({ runId: t.runId, targetId: t.targetId, name: t.targetName })),
          }
        : null,
    } satisfies EnvStatusDto;
  });
}

// ------------------------------------------------------------------------------------------------ answers to DevOps questions

export interface QuestionAnswer {
  path: string;
  value: string | number | boolean;
}

/** `POST /api/setup-proposals/:id/answers`: the server merges each answer at its path, checks the proposal again and keeps them. */
export function useAnswerProposal(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { proposalId: string; answers: QuestionAnswer[] }) =>
      post<{ proposal: ProposalDto; remaining: number }>(`/setup-proposals/${v.proposalId}/answers`, {
        answers: v.answers,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: setupKey(projectId) });
      void qc.invalidateQueries({ queryKey: ['run-plan', projectId] });
    },
  });
}

// ------------------------------------------------------------------------------------------------ removal

function useInvalidateEnvs(projectId: string) {
  const qc = useQueryClient();
  return () => {
    for (const key of [
      setupKey(projectId),
      statusKey(projectId),
      ['deploy-targets', projectId],
      ['delivery', projectId],
      queueKey,
      runsKey,
    ])
      void qc.invalidateQueries({ queryKey: key });
  };
}

/** Removes a place (a deploy target); `revokeKey` also takes Guildwise's own sign-in key off the server. */
export function useRemovePlace(projectId: string) {
  const done = useInvalidateEnvs(projectId);
  return useMutation({
    mutationFn: (v: { id: string; revokeKey?: boolean }) =>
      del<{ ok?: boolean }>(`/deploy-targets/${v.id}${v.revokeKey ? '?revokeKey=1' : ''}`),
    onSuccess: done,
  });
}

/** Re-points every environment and queued release of `fromId` to `toId`, then removes `fromId`. */
export function useMergePlaces(projectId: string) {
  const done = useInvalidateEnvs(projectId);
  return useMutation({
    mutationFn: (v: { fromId: string; toId: string }) => post<{ ok: boolean }>('/deploy-targets/merge', v),
    onSuccess: done,
  });
}

/** Throws away the unfinished setup of the project (the wizard's draft). */
export function useDiscardDraft(projectId: string) {
  const done = useInvalidateEnvs(projectId);
  return useMutation({
    mutationFn: () => del<{ ok: boolean }>(`/projects/${projectId}/delivery/setup/draft`),
    onSuccess: done,
  });
}

/** Takes one environment out of the setup (`DELETE .../delivery/environments/:name`): the steps are made again and need approving. */
export function useRemoveEnvironment(projectId: string) {
  const done = useInvalidateEnvs(projectId);
  return useMutation({
    mutationFn: (name: string) =>
      del<{ ok?: boolean }>(`/projects/${projectId}/delivery/environments/${encodeURIComponent(name)}`),
    onSuccess: done,
  });
}

/** The files of `delivery/` that Guildwise does not make (a smoke test, an old script), read from a preview of what is saved. */
export function useUnmodelledFiles(projectId: string | undefined, setup: unknown, key: string) {
  return useQuery({
    enabled: !!projectId && !!setup,
    queryKey: ['env-unmodelled', projectId, key],
    retry: false,
    queryFn: async (): Promise<string[]> => {
      const p = await post<{ unmodelled?: string[] }>(`/projects/${projectId}/delivery/setup/preview`, {
        setup,
      });
      return p.unmodelled ?? [];
    },
  });
}
