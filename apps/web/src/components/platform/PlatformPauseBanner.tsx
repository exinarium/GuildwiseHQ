import type { PlatformPauseDto } from '@aom/shared';
import { useMyPlatformPauses } from '../../api/queries/platformTeam.ts';
import { Callout } from '../ui.tsx';

/** Which pauses hold back a project: its own, or one that covers every project (a workflow or stage). */
export function pausesForProject(pauses: PlatformPauseDto[], projectId: string): PlatformPauseDto[] {
  return pauses.filter(
    (p) => p.projectId === projectId || (p.projectId === null && p.workstationId === null),
  );
}

/** A banner on a project the platform team paused (only what a bug hits is paused; the rest of the work runs). */
export function PlatformPauseBanner({ projectId }: { projectId: string }) {
  const mine = useMyPlatformPauses();
  const list = pausesForProject(mine.data ?? [], projectId);
  if (list.length === 0) return null;
  return (
    <Callout
      tone="warning"
      className="mb-3"
      title="New work is paused by the platform team"
      data-testid="platform-pause-banner"
    >
      {list.map((p) => (
        <p key={p.id} className="text-sm">
          {p.reason}
          {p.stageId ? ` (stage ${p.stageId})` : ''}
          {p.bugCardRef ? ` Fix: ${p.bugCardRef}.` : ''} Running shifts finish; work resumes by itself when
          the fix is deployed.
        </p>
      ))}
    </Callout>
  );
}
