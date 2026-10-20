import type { RunnerUpdateCheckResult, WorkstationDto } from '@aom/shared';
import { errorMessage } from '../../api/client.ts';
import { useCheckForUpdates } from '../../api/queries/workstations.ts';
import { Button } from '../ui.tsx';

export const OLD_RUNNER_HINT = 'Runner 0.1.34+ needed. It checks for updates by itself once a day.';

/** What the runner answered, in one line. `current` is the version the runner runs now. */
export function updateCheckText(r: RunnerUpdateCheckResult, current: string | null): string {
  switch (r.outcome) {
    case 'up_to_date':
      return `Up to date (${r.version ?? current ?? 'latest'})`;
    case 'update_found':
      return `Update ${r.version ?? ''} found: installs when idle`.replace('  ', ' ');
    case 'paused':
      return 'Updates are paused';
    case 'disabled':
      return 'Updates are turned off on this machine';
    case 'failed':
      return `Check failed${r.detail ? `: ${r.detail}` : ''}`;
  }
}

/**
 * "Check for updates" next to the runner version: asks the runner to run its updater's check now (download, verify and
 * the wait for idle are the usual ones; this only skips the timer). Shows the runner's answer inline.
 */
export function CheckForUpdates({ w }: { w: WorkstationDto }) {
  const check = useCheckForUpdates(w.id);
  const uc = w.updateCheck;
  const supported = uc?.supported === true;
  const checking = check.isPending || uc?.state === 'checking';
  const reason = !supported ? OLD_RUNNER_HINT : !w.connected ? 'This workstation is offline.' : undefined;
  let note: { text: string; title?: string; tone: 'muted' | 'danger' } | null = null;
  if (check.isError) note = { text: errorMessage(check.error), tone: 'danger' };
  else if (!checking && uc?.state === 'timed_out')
    note = { text: 'The runner did not answer', tone: 'danger' };
  else if (!checking && uc?.result)
    note = {
      text: updateCheckText(uc.result, w.runnerVersion ?? null),
      title: `${uc.result.detail ? `${uc.result.detail}. ` : ''}Checked ${new Date(uc.result.at).toLocaleString()}.`,
      tone: uc.result.outcome === 'failed' ? 'danger' : 'muted',
    };
  return (
    <span className="flex items-center gap-2" data-testid="update-check">
      <span title={reason}>
        <Button
          variant="secondary"
          size="sm"
          loading={checking}
          disabled={!!reason}
          onClick={() => check.mutate()}
          aria-label={`Check ${w.name} for updates`}
          data-testid="update-check-button"
        >
          {checking ? 'Checking...' : 'Check for updates'}
        </Button>
      </span>
      {note && (
        <span
          role="status"
          title={note.title}
          data-testid="update-check-result"
          className={`max-w-64 truncate text-xs ${note.tone === 'danger' ? 'text-danger' : 'text-muted'}`}
        >
          {note.text}
        </span>
      )}
    </span>
  );
}
