import { useSignedRunnersStatus } from '../../api/queries/security-settings.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Button } from '../ui/Button.tsx';
import { Callout } from '../ui/Callout.tsx';

/**
 * "Reinstall required" (R21): the caller's workstations this server unpaired because they ran an unsigned or outdated
 * runner, until the same computer is added again. Reinstalling opens "Add a workstation", whose one-line installer stops
 * the old runner and quarantines its files.
 */
export function ReinstallRequired({ onReinstall }: { onReinstall: () => void }) {
  const status = useSignedRunnersStatus();
  const list = status.data?.reinstallRequired ?? [];
  if (list.length === 0) return null;
  return (
    <div className="mb-4" data-testid="reinstall-required">
      <Callout tone="warning" role="status" title="Reinstall required">
        <p>
          This server now accepts only signed runners from {status.data?.since} on, so it unpaired{' '}
          {list.length === 1 ? 'this workstation' : 'these workstations'}. The old runner can no longer
          connect or update itself. Add the computer again: the installer removes the old runner, and you
          never reuse its files. If you had given the old runner sudo, change your computer password.
        </p>
        <ul className="mt-2 flex flex-col gap-1">
          {list.map((w) => (
            <li key={w.id} data-testid="reinstall-required-item">
              <strong>{w.name}</strong> ({w.hostname}), unpaired {formatDateTime(w.unlinkedAt)}
            </li>
          ))}
        </ul>
        <div className="mt-3">
          <Button
            variant="primary"
            className="max-sm:min-h-11"
            onClick={onReinstall}
            data-testid="reinstall-runner"
          >
            Reinstall the runner
          </Button>
        </div>
      </Callout>
    </div>
  );
}

/** The note on "Add a workstation" while "Only signed runners" is on (R21). */
export function SignedRunnersInstallNote() {
  const status = useSignedRunnersStatus();
  if (!status.data?.requireSignedRunners) return null;
  return (
    <Callout tone="info" role="note" data-testid="signed-runners-install-note">
      Runners from before {status.data.since} are refused here. This installer removes an old runner from your
      machine; never reuse its files.
    </Callout>
  );
}
