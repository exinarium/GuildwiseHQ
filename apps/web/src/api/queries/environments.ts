import type {
  EnvCardState,
  EnvironmentStatusDto,
  EnvironmentsStatusResponse,
  PlacesResponse,
  ProposalDto,
  ReleaseQueueItem,
  RemoveEnvironmentResult,
  SetupStateDto,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, post, put } from '../client.ts';
import { queueKey, runsKey } from './delivery.ts';
import { setupKey } from './deploy-setup.ts';

/**
 * The API layer of the Environments page (docs/design/environments-ux.md section 13, "API contract (as built)"). Reads fall back
 * to what the older endpoints already tell (the setup state, the deploy runs, the release queue) when the newer endpoint is not
 * there, so the page also works against an older server.
 */

// ------------------------------------------------------------------------------------------------ status of an environment

export type EnvHealth = 'healthy' | 'unhealthy' | 'unknown' | 'updating';

export interface EnvRelease {
  commit: string;
  version: string | null;
  /** The cards merged since the live version ("from 3 merged cards"), when the server says. */
  cards: Array<{ ref: string; title: string }>;
  /** Every rule holds now. */
  rulesMet: boolean;
  /** The rules that do not hold yet, in plain words ("test site healthy for 3 more minutes"). */
  waitingFor: string[];
  /** The deploy runs a Release presses (one per place), from the release queue. */
  places: Array<{ runId: string; targetId: string | null; name: string }>;
}

/** What the page needs of an environment's status: the contract's `EnvironmentStatusDto`, flattened for the cards. */
export interface EnvStatusDto {
  env: string;
  version: string | null;
  commit: string | null;
  since: string | null;
  health: EnvHealth;
  appUrl: string | null;
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
  /** The server's own verdict for the card chip, when it gives one (section 13.3). */
  serverState?: EnvCardState;
  stateText?: string;
  savedState?: EnvironmentStatusDto['savedState'];
  triedState?: EnvironmentStatusDto['triedState'];
  approvalState?: EnvironmentStatusDto['approvalState'];
  openQuestions?: number;
  runtime?: 'docker' | 'direct';
  rules?: string[];
}

export const statusKey = (projectId: string) => ['env-status', projectId] as const;

/** A short version label for a commit. */
export const shortVersion = (commit: string | null | undefined) => (commit ? commit.slice(0, 7) : null);

const RUN_STATUS = ['succeeded', 'failed', 'refused', 'running', 'queued'] as const;
const runStatus = (s: string): NonNullable<EnvStatusDto['lastRun']>['status'] =>
  (RUN_STATUS as readonly string[]).includes(s) ? (s as (typeof RUN_STATUS)[number]) : 'failed';

/** The contract's status of one environment, as the cards read it. The queue tells which runs a Release presses. */
export function adaptStatus(
  d: EnvironmentStatusDto,
  queue: ReleaseQueueItem[],
  projectId: string,
): EnvStatusDto {
  const q = queue.find((x) => x.projectId === projectId && x.env === d.env);
  return {
    env: d.env,
    version: d.current?.version ?? shortVersion(d.current?.commit),
    commit: d.current?.commit ?? null,
    since: d.current?.since ?? null,
    health: d.state === 'updating' ? 'updating' : d.health.state,
    appUrl: d.appUrl,
    lastRun: d.lastRun
      ? {
          id: d.lastRun.runId,
          status: runStatus(d.lastRun.status),
          at: d.lastRun.at,
          summary: d.lastRun.summary,
          failedStep: null,
          reason: d.lastRun.summary,
          wentBackTo: d.lastRun.rolledBack ? 'the earlier version' : null,
        }
      : null,
    waitingRelease: d.waitingRelease
      ? {
          commit: d.waitingRelease.commit ?? '',
          version: shortVersion(d.waitingRelease.commit),
          cards: [],
          rulesMet: d.blockedBy.length === 0,
          waitingFor: d.blockedBy,
          places: (q?.targets ?? []).map((t) => ({
            runId: t.runId,
            targetId: t.targetId,
            name: t.targetName,
          })),
        }
      : null,
    serverState: d.state,
    stateText: d.stateText,
    savedState: d.savedState,
    triedState: d.triedState,
    approvalState: d.approvalState,
    openQuestions: d.openQuestions,
    runtime: d.runtime,
    rules: d.rules,
  };
}

export function useEnvStatus(projectId: string | undefined) {
  return useQuery({
    enabled: !!projectId,
    queryKey: statusKey(projectId ?? ''),
    refetchInterval: 15_000,
    retry: false,
    queryFn: async (): Promise<EnvStatusDto[]> => {
      const queue = await get<{ items: ReleaseQueueItem[] }>('/delivery/queue').catch(() => ({ items: [] }));
      try {
        const d = await get<EnvironmentsStatusResponse>(`/projects/${projectId}/environments/status`);
        return (d.environments ?? []).map((e) => adaptStatus(e, queue.items, projectId ?? ''));
      } catch (e) {
        if (!(e instanceof ApiError) || ![404, 403].includes(e.status)) throw e;
      }
      // An older server: read what the deploy history and the release queue say.
      const runs = await get<{ runs: DeployRunLite[] }>('/delivery/runs?limit=60').catch(() => ({
        runs: [],
      }));
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
            status: runStatus(last.status),
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

// ------------------------------------------------------------------------------------------------ places

export const placesKey = (projectId: string) => ['places', projectId] as const;

/** `GET /api/projects/:id/places`; null while an older server does not know it (the page then derives places from the setup state). */
export function usePlacesApi(projectId: string | undefined) {
  return useQuery({
    enabled: !!projectId,
    queryKey: placesKey(projectId ?? ''),
    retry: false,
    queryFn: async (): Promise<PlacesResponse | null> => {
      try {
        const d = await get<PlacesResponse>(`/projects/${projectId}/places`);
        return Array.isArray(d.places) ? d : null;
      } catch (e) {
        if (e instanceof ApiError && [404, 403].includes(e.status)) return null;
        throw e;
      }
    },
  });
}

// ------------------------------------------------------------------------------------------------ answers to DevOps questions

export interface QuestionAnswer {
  path: string;
  value: string;
}

/** `POST /api/setup-proposals/:id/answers`: the server stores each answer on its question and applies it to the suggestion. */
export function useAnswerProposal(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { proposalId: string; answers: QuestionAnswer[] }) =>
      post<ProposalDto>(`/setup-proposals/${v.proposalId}/answers`, { answers: v.answers }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: setupKey(projectId) });
      void qc.invalidateQueries({ queryKey: ['run-plan', projectId] });
    },
  });
}

// ------------------------------------------------------------------------------------------------ removal and changes

function useInvalidateEnvs(projectId: string) {
  const qc = useQueryClient();
  return () => {
    for (const key of [
      setupKey(projectId),
      statusKey(projectId),
      placesKey(projectId),
      ['deploy-targets', projectId],
      ['delivery', projectId],
      ['env-unmodelled', projectId],
      queueKey,
      runsKey,
    ])
      void qc.invalidateQueries({ queryKey: key });
  };
}

/** Removes a place; `revokeKey` also takes Guildwise's own sign-in key off the server (409 `place_in_use` names the environments). */
export function useRemovePlace(projectId: string) {
  const done = useInvalidateEnvs(projectId);
  return useMutation({
    mutationFn: (v: { id: string; revokeKey?: boolean }) =>
      post<{ removed: true; keyCleanup: { state: string; reason: string | null } }>(
        `/projects/${projectId}/places/${v.id}/remove`,
        { removeKey: !!v.revokeKey },
      ),
    onSuccess: done,
  });
}

/** Two places that are the same server or the same computer: the draft and unfinished follow-ups point at `toId`. */
export function useMergePlaces(projectId: string) {
  const done = useInvalidateEnvs(projectId);
  return useMutation({
    mutationFn: (v: { fromId: string; toId: string }) =>
      post<{ repointed: string[]; removed: boolean; stillUsedBySaved: string[] }>(
        `/projects/${projectId}/places/merge`,
        v,
      ),
    onSuccess: done,
  });
}

/** Throws away the unfinished setup of the project (the draft). */
export function useDiscardDraft(projectId: string) {
  const done = useInvalidateEnvs(projectId);
  return useMutation({
    mutationFn: () => post<SetupStateDto>(`/projects/${projectId}/delivery/setup/discard-draft`, {}),
    onSuccess: done,
  });
}

/**
 * Takes one environment out of the draft (`remove-environment`); the caller saves the draft after it, because nothing is
 * deleted before a save and an approval. 422 `last_environment`: use `useStopGuided` instead.
 */
export function useRemoveEnvironment(projectId: string) {
  const done = useInvalidateEnvs(projectId);
  return useMutation({
    mutationFn: (env: string) =>
      post<SetupStateDto & RemoveEnvironmentResult>(
        `/projects/${projectId}/delivery/setup/remove-environment`,
        {
          env,
        },
      ),
    onSuccess: done,
  });
}

/** "Stop using guided deploys": back to instructions mode; places, keys and files stay. */
export function useStopGuided(projectId: string) {
  const done = useInvalidateEnvs(projectId);
  return useMutation({
    mutationFn: () =>
      post<SetupStateDto>(`/projects/${projectId}/delivery/setup/stop-guided`, { confirm: true }),
    onSuccess: done,
  });
}

/** Points an environment of the draft at another place (a server environment needs a server place). */
export function useSetEnvironmentPlace(projectId: string) {
  const done = useInvalidateEnvs(projectId);
  return useMutation({
    mutationFn: (v: { env: string; placeId: string }) =>
      put<SetupStateDto>(
        `/projects/${projectId}/delivery/setup/environments/${encodeURIComponent(v.env)}/place`,
        {
          placeId: v.placeId,
        },
      ),
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

/**
 * Saves the draft: the preview of exactly this setup, then the publish of the hash it showed. `ok: false` carries the plain
 * reasons the steps cannot be saved yet (nothing was written).
 */
export function usePublishDraft(projectId: string) {
  const done = useInvalidateEnvs(projectId);
  return useMutation({
    mutationFn: async (setup: unknown): Promise<{ ok: true } | { ok: false; issues: string[] }> => {
      const p = await post<{ ok: boolean; hash: string | null; issues: string[] }>(
        `/projects/${projectId}/delivery/setup/preview`,
        { setup },
      );
      if (!p.ok || !p.hash) return { ok: false, issues: p.issues };
      await post(`/projects/${projectId}/delivery/setup/publish`, { setup, setupHash: p.hash });
      return { ok: true };
    },
    onSuccess: done,
  });
}
