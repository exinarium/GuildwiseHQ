import {
  isQuietRepoSyncReason,
  REPO_SYNC_REASON_TEXT,
  type RepoSyncDto,
  type RepoSyncReason,
} from '@aom/shared';
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

/** What to tell the user about a working branch: always a line once it has been checked, so "in step" is visible too. */
export function syncText(
  s: RepoSyncDto,
): { text: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } | null {
  const b = s.workingBranch;
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;
  switch (s.state) {
    case 'synced':
    case 'updated':
      return {
        text: `${b} is in sync with origin${s.dirty ? ' (your checkout has uncommitted changes)' : ''}`,
        tone: 'success',
      };
    case 'behind':
      return { text: `${b} is ${n(s.behind, 'commit')} behind origin`, tone: 'warning' };
    case 'busy':
      return {
        text: `${b} is ${n(s.behind, 'commit')} behind origin (a card shift is running here; it catches up afterwards)`,
        tone: 'neutral',
      };
    case 'dirty':
      return {
        // With a reason, the reason badge explains it; the detail is for an older runner that sends none.
        text: `${b} is ${n(s.behind, 'commit')} behind origin and was not synced${s.reason ? '' : `: ${s.detail ?? 'the checkout has uncommitted changes'}`}`,
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
      return {
        text: `${b} could not be checked${s.detail && !s.reason ? `: ${s.detail}` : ''}`,
        tone: 'neutral',
      };
    case 'no_remote':
      return { text: `${b}: the clone has no origin remote`, tone: 'neutral' };
    case 'missing_branch':
      return { text: `${b} has no local branch on this workstation`, tone: 'neutral' };
    default:
      return null;
  }
}

/** Skips that are expected and need nothing from the user: a neutral badge rather than a warning. */
const NEUTRAL_REASONS: readonly RepoSyncReason[] = [
  'shift-running',
  'read-only',
  'no-remote',
  'no-local-branch',
];

/**
 * Why the last sync left the branch unchanged, as a second badge: null when there is no reason (an update, or an older
 * runner), for the quiet codes the state badge already says, and for an update. Never the danger tone, so a skip looks
 * different from an error and from the green success badge.
 */
export function syncReason(s: RepoSyncDto): { text: string; tone: 'warning' | 'neutral' } | null {
  if (!s.reason || isQuietRepoSyncReason(s.reason) || s.state === 'updated') return null;
  const text = s.reasonMessage?.trim() || REPO_SYNC_REASON_TEXT[s.reason];
  if (!text) return null;
  return { text, tone: NEUTRAL_REASONS.includes(s.reason) ? 'neutral' : 'warning' };
}

/**
 * One line under a repository: "alex/dev is in sync with origin" or "alex/dev is 3 behind origin", when it was last
 * checked, and a "Sync now" button (only where the user may sync: their own workstation). Nothing is shown until the
 * runner has checked the branch once.
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
  const reason = syncReason(sync);
  const canFix = sync.state !== 'ahead';
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs" data-testid="repo-sync">
      <Badge tone={t.tone}>
        {where ? `${where}: ` : ''}
        {t.text}
      </Badge>
      {reason && (
        <Badge tone={reason.tone} data-testid="repo-sync-reason">
          <span className="min-w-0 whitespace-normal break-words">Left unchanged: {reason.text}</span>
        </Badge>
      )}
      {sync.checkedAt && (
        <span className="text-muted" data-testid="repo-sync-checked">
          checked {new Date(sync.checkedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
        </span>
      )}
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
