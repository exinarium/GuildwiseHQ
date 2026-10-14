import type { RepoSyncDto } from '@aom/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { post } from '../api/client.ts';
import { Badge, Button, useToast } from './ui.tsx';

/** "Sync now": the runner fetches the working branch and fast-forwards it when that is safe, then reports. */
export function useSyncNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { workstationId: string; repoId: string }) =>
      post(`/workstations/${v.workstationId}/repos/${v.repoId}/sync`, {}),
    onSuccess: () => {
      // The runner answers within a moment: refresh a few times.
      for (const ms of [800, 2500, 6000]) {
        setTimeout(() => qc.invalidateQueries({ queryKey: ['workstations'] }), ms);
        setTimeout(() => qc.invalidateQueries({ queryKey: ['project'] }), ms);
      }
    },
  });
}

/** What to tell the user about a working branch (null: nothing worth saying, it is in step). */
export function syncText(s: RepoSyncDto): { text: string; tone: 'warning' | 'danger' | 'neutral' } | null {
  const b = s.workingBranch;
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;
  switch (s.state) {
    case 'synced':
    case 'updated':
      return null;
    case 'behind':
      return { text: `${b} is ${n(s.behind, 'commit')} behind origin`, tone: 'warning' };
    case 'busy':
      return {
        text: `${b} is ${n(s.behind, 'commit')} behind origin (a card shift is running here; it catches up afterwards)`,
        tone: 'neutral',
      };
    case 'dirty':
      return {
        text: `${b} is ${n(s.behind, 'commit')} behind origin and has uncommitted changes`,
        tone: 'warning',
      };
    case 'diverged':
      return {
        text: `${b} has diverged from origin (${n(s.ahead, 'local commit')}, ${n(s.behind, 'new commit')} on origin)`,
        tone: 'danger',
      };
    case 'ahead':
      return { text: `${b} is ${n(s.ahead, 'commit')} ahead of origin`, tone: 'neutral' };
    case 'error':
      return { text: `${b} could not be checked${s.detail ? `: ${s.detail}` : ''}`, tone: 'neutral' };
    default:
      return null;
  }
}

/**
 * One line under a repository: "pieter/dev is 3 behind origin" with a "Sync now" button (only where the user may
 * sync: their own workstation). Nothing is shown while the branch is in step or has not been checked.
 */
export function RepoSyncLine({
  sync,
  workstationId,
  repoId,
  canSync,
  where,
}: {
  sync: RepoSyncDto | null | undefined;
  workstationId: string;
  repoId: string;
  canSync: boolean;
  /** The workstation's name when several are listed. */
  where?: string;
}) {
  const now = useSyncNow();
  const toast = useToast();
  if (!sync) return null;
  const t = syncText(sync);
  if (!t) return null;
  const canFix = sync.state !== 'ahead';
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs" data-testid="repo-sync">
      <Badge tone={t.tone === 'neutral' ? 'neutral' : t.tone}>
        {where ? `${where}: ` : ''}
        {t.text}
      </Badge>
      {canSync && canFix && (
        <Button
          size="sm"
          data-testid="sync-now"
          loading={now.isPending}
          onClick={() =>
            now.mutate(
              { workstationId, repoId },
              { onSuccess: () => toast.success('Asked the runner to sync') },
            )
          }
        >
          Sync now
        </Button>
      )}
    </p>
  );
}
