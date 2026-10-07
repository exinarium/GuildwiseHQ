import type { ProjectDto, ProjectRepoDto } from '@aom/shared';
import { ArrowRightLeft } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useCancelConversion } from '../api/queries/projects.ts';
import { ConvertProjectDialog } from './ConvertProjectDialog.tsx';
import { projectTypeLabel } from './shell/ProjectSwitcher.tsx';
import { Badge, Button, Callout, ErrorBox, Panel, useToast } from './ui.tsx';

const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';

/**
 * Project settings, "Stage": what the project started as, what it is now, and (Owner and Admins) the Convert button.
 * A conversion that waits for a new repository shows its requests here, with a way to cancel it.
 */
export function ConvertPanel({
  project,
  repos,
  canConvert,
}: {
  project: ProjectDto;
  repos: ProjectRepoDto[];
  canConvert: boolean;
}) {
  const [open, setOpen] = useState(false);
  const cancel = useCancelConversion(project.id);
  const toast = useToast();
  const started = project.startedAs ?? project.workflowKey;
  const researching = project.workflowKey === 'research';
  const pending = project.pendingConversion;
  const archived = project.status === 'archived';

  return (
    <Panel title="Stage" data-testid="stage-panel">
      <div className="flex flex-col gap-3">
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <span data-testid="stage-current">
            Now a <strong className="font-semibold text-fg">{projectTypeLabel(project.workflowKey)}</strong>{' '}
            project.
          </span>
          {started !== project.workflowKey && (
            <span data-testid="stage-started-as">
              <Badge>Started as {projectTypeLabel(started)}</Badge>
            </span>
          )}
          {project.convertedAt && <span>Converted {day(project.convertedAt)}.</span>}
        </p>
        {researching && (
          <p className="text-sm text-muted">
            This project is in the research stage: it has no repositories and agents only research. Convert it
            to a delivery project, usually Code, when the questions are answered.
          </p>
        )}
        {pending && (
          <Callout tone="info" title="Waiting for a repository" data-testid="pending-conversion">
            <p>
              The conversion to {projectTypeLabel(pending.toWorkflowKey)} completes when the new repository
              exists. Approve the request on the desk, then your runner creates it.
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {pending.requests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  <Badge
                    tone={r.status === 'created' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}
                  >
                    {r.status}
                  </Badge>
                  {(r.status === 'pending' || r.status === 'failed') && (
                    <Link to="/desk" className="underline">
                      Open the desk
                    </Link>
                  )}
                </li>
              ))}
            </ul>
            {canConvert && (
              <Button
                className="mt-2"
                size="sm"
                data-testid="cancel-conversion"
                loading={cancel.isPending}
                onClick={() =>
                  cancel.mutate(undefined, { onSuccess: () => toast.info('Conversion cancelled') })
                }
              >
                Cancel the conversion
              </Button>
            )}
            <ErrorBox error={cancel.error} />
          </Callout>
        )}
        {canConvert && !archived && !pending && (
          <Button
            variant="primary"
            className="self-start"
            data-testid="convert-open"
            onClick={() => setOpen(true)}
          >
            <ArrowRightLeft aria-hidden="true" className="size-4" />
            {researching ? 'Convert to project' : 'Convert project'}
          </Button>
        )}
        {!canConvert && (
          <p className="text-xs text-subtle">
            Only the organization's Owner and Admins can convert a project.
          </p>
        )}
      </div>
      {canConvert && (
        <ConvertProjectDialog project={project} repos={repos} open={open} onOpenChange={setOpen} />
      )}
    </Panel>
  );
}
