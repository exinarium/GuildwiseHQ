import type { DnsCheckDto, MoveCompleteRequest, MoveDto, MoveListDto, MoveStartRequest } from '@aom/shared';
import { MOVE_OPEN_STATES } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../client.ts';
import { setupKey } from './deploy-setup.ts';

/**
 * Moving to a new server (docs/design/deploy-run-ux-design.md J6, v3): the moves of a project (followed every two seconds while
 * a step runs), the person's decisions (start, agree to the downtime, try again, give up, make it live) and the live DNS check.
 */
export const movesKey = (projectId: string) => ['deploy-moves', projectId] as const;

const RUNNING: readonly string[] = ['preparing', 'moving'];

export function useMoves(projectId: string | undefined, enabled = true) {
  return useQuery({
    enabled: !!projectId && enabled,
    queryKey: movesKey(projectId ?? ''),
    queryFn: async (): Promise<MoveDto[]> => {
      try {
        return (await get<MoveListDto>(`/projects/${projectId}/delivery/moves`)).moves;
      } catch {
        // an older server has no moves
        return [];
      }
    },
    refetchInterval: (q) => ((q.state.data ?? []).some((m) => RUNNING.includes(m.state)) ? 2000 : false),
    retry: false,
  });
}

/** The move that is not over (including a failed one that waits for a decision), if any. */
export const openMove = (moves: readonly MoveDto[] | undefined): MoveDto | undefined =>
  (moves ?? []).find((m) => (MOVE_OPEN_STATES as readonly string[]).includes(m.state));

function useMoveMutation<V, R>(projectId: string, fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: movesKey(projectId) });
      void qc.invalidateQueries({ queryKey: setupKey(projectId) });
      void qc.invalidateQueries({ queryKey: ['deploy-targets', projectId] });
      void qc.invalidateQueries({ queryKey: ['places', projectId] });
      void qc.invalidateQueries({ queryKey: ['env-status', projectId] });
    },
  });
}

const base = (projectId: string) => `/projects/${projectId}/delivery`;

export const useStartMove = (projectId: string) =>
  useMoveMutation(projectId, (v: MoveStartRequest) => post<MoveDto>(`${base(projectId)}/moves`, v));

export const useSwitchMove = (projectId: string) =>
  useMoveMutation(projectId, (moveId: string) =>
    post<MoveDto>(`${base(projectId)}/moves/${moveId}/switch`, { agreedDowntime: true }),
  );

export const useRetryMove = (projectId: string) =>
  useMoveMutation(projectId, (moveId: string) => post<MoveDto>(`${base(projectId)}/moves/${moveId}/retry`));

export const useCancelMove = (projectId: string) =>
  useMoveMutation(projectId, (moveId: string) => post<MoveDto>(`${base(projectId)}/moves/${moveId}/cancel`));

export const useCompleteMove = (projectId: string) =>
  useMoveMutation(projectId, (v: { moveId: string } & MoveCompleteRequest) =>
    post<MoveDto>(`${base(projectId)}/moves/${v.moveId}/complete`, { dns: v.dns }),
  );

export const useRetire = (projectId: string) =>
  useMoveMutation(projectId, (targetId: string) =>
    post<{ commandId: string }>(`${base(projectId)}/targets/${targetId}/retire`, { confirmed: true }),
  );

/** The live check of the domain: asked every few seconds while the person waits for the change to spread. */
export function useDns(projectId: string, moveId: string | null | undefined, enabled: boolean) {
  return useQuery({
    enabled: !!moveId && enabled,
    queryKey: ['deploy-move-dns', projectId, moveId],
    queryFn: () => get<DnsCheckDto>(`${base(projectId)}/moves/${moveId}/dns`),
    refetchInterval: (q) => (q.state.data?.state === 'new' ? false : 8000),
    retry: false,
  });
}
