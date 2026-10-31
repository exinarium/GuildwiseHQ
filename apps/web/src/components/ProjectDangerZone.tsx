import type { ProjectDto } from '@aom/shared';
import { useState } from 'react';
import { useArchiveProject, useProjectImpact, useRestoreProject } from '../api/queries/projects.ts';
import { Reword } from './Reword.tsx';
import { Badge, Button, Dialog, ErrorBox, Panel, Spinner, useToast } from './ui.tsx';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Project settings, "Danger zone": archive an active project (any member), or restore an archived one. Archiving asks
 * for a confirmation that lists what will stop. Permanent delete lives on the Projects page (Archived section).
 */
export function ProjectDangerZone({ project }: { project: ProjectDto }) {
  const [confirming, setConfirming] = useState(false);
  const archive = useArchiveProject(project.id);
  const restore = useRestoreProject();
  const impact = useProjectImpact(project.id, confirming);
  const toast = useToast();
  const archived = project.status === 'archived';

  return (
    <Panel data-testid="danger-zone" className="border-danger-fill/40">
      <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold text-danger">
        Danger zone
        {archived && <Badge tone="amber">Archived</Badge>}
      </h2>
      {archived ? (
        <>
          <p className="text-sm text-muted" data-testid="archived-note">
            <Reword>
              {
                'This project is archived. It is hidden from boards, pickers and the dispatcher; its cards, history and vault folder are kept. Restore it to work on it again (cards that were closed stay closed and schedules stay off).'
              }
            </Reword>
          </p>
          <Button
            className="mt-3"
            variant="primary"
            disabled={restore.isPending}
            data-testid="restore-project"
            onClick={() =>
              restore.mutate(project.id, { onSuccess: () => toast.success(`${project.name} restored`) })
            }
          >
            Restore project
          </Button>
          <ErrorBox error={restore.error} />
        </>
      ) : (
        <>
          <p className="text-sm text-muted">
            Archive this project to take it out of use. Running shifts stop, open cards close, schedules stop
            and open desk items are dismissed. Nothing is deleted; you can restore it later.
          </p>
          <Button
            className="mt-3"
            variant="danger"
            data-testid="archive-project"
            onClick={() => setConfirming(true)}
          >
            Archive project
          </Button>
        </>
      )}
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Archive ${project.key}?`}
        description="This stops the project's work straight away."
      >
        <div data-testid="archive-dialog" className="flex flex-col gap-3">
          {impact.isPending && <Spinner inline label="Checking what would stop" />}
          {impact.isError && <ErrorBox error={impact.error} />}
          {impact.data && (
            <ul className="list-disc pl-5 text-sm" data-testid="archive-impact">
              <li data-testid="impact-shifts">
                {plural(impact.data.activeShifts, 'active shift')} will be cancelled and their worktrees
                removed
              </li>
              <li data-testid="impact-cards">
                {plural(impact.data.openCards, 'open card')} will be closed as archived
              </li>
              <li data-testid="impact-schedules">{plural(impact.data.schedules, 'schedule')} will stop</li>
              <li data-testid="impact-desk">
                {plural(impact.data.openDeskItems, 'open desk item')} will be dismissed
              </li>
            </ul>
          )}
          <p className="text-xs text-subtle">
            <Reword>
              {
                'Agents hired for this project are not fired; they just stop getting its work. The vault folder is never touched.'
              }
            </Reword>
          </p>
          <ErrorBox error={archive.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={archive.isPending || !impact.data}
              data-testid="archive-confirm"
              onClick={() =>
                archive.mutate(undefined, {
                  onSuccess: () => {
                    setConfirming(false);
                    toast.success(`${project.name} archived`);
                  },
                })
              }
            >
              Archive project
            </Button>
          </div>
        </div>
      </Dialog>
    </Panel>
  );
}
