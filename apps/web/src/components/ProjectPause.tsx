import type { ProjectDto } from '@aom/shared';
import { Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { usePauseProject, useResumeProject } from '../api/queries/projects.ts';
import { useCanManageProject } from '../lib/projectWorkflow.ts';
import { formatUntil } from './UsageLimitBanner.tsx';
import { Badge, Button, Callout, Dialog, ErrorBox, TextArea } from './ui.tsx';

export const PAUSE_REASON_MAX = 500;

/** "Pause project" in the board header: only an organization Owner or Admin sees it, and only while the project runs. */
export function PauseProjectButton({ project }: { project: ProjectDto }) {
  const allowed = useCanManageProject(project);
  const pause = usePauseProject(project.id);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!allowed || project.paused) return null;
  const close = (o: boolean) => {
    setOpen(o);
    if (!o) {
      setReason('');
      pause.reset();
    }
  };
  return (
    <>
      <Button data-testid="pause-project-open" onClick={() => setOpen(true)}>
        <Pause aria-hidden="true" className="size-4" />
        Pause project
      </Button>
      <Dialog
        open={open}
        onOpenChange={close}
        title={`Pause ${project.name}?`}
        description="Nothing new starts on this project until an Owner or Admin resumes it. Shifts already running finish."
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              data-testid="pause-project-confirm"
              loading={pause.isPending}
              onClick={() => pause.mutate(reason, { onSuccess: () => close(false) })}
            >
              Pause project
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm text-muted">
          <p>
            Cards stay where they are and keep their place in the queue. People can still view and edit cards,
            create new ones and answer questions; agents pick the work up again when the project is resumed.
          </p>
          <TextArea
            label="Reason (optional)"
            hint="Shown to everyone on the project's banner."
            value={reason}
            maxLength={PAUSE_REASON_MAX}
            onChange={(e) => setReason(e.target.value)}
            data-testid="pause-project-reason"
          />
          <ErrorBox error={pause.error} />
        </div>
      </Dialog>
    </>
  );
}

/** The banner of a project paused by hand: who, when and why; "Resume project" for Owners and Admins only. */
export function ProjectPausedBanner({ project }: { project: ProjectDto }) {
  const allowed = useCanManageProject(project);
  const resume = useResumeProject(project.id);
  const paused = project.paused;
  if (!paused) return null;
  return (
    <Callout
      tone="warning"
      role="status"
      data-testid="project-paused-banner"
      title={`Paused by ${paused.byName} (${formatUntil(paused.at)})`}
      className="mb-3"
      actions={
        allowed ? (
          <Button
            size="sm"
            variant="primary"
            data-testid="resume-project"
            loading={resume.isPending}
            onClick={() => resume.mutate()}
          >
            <Play aria-hidden="true" className="size-4" />
            Resume project
          </Button>
        ) : undefined
      }
    >
      <p className="text-sm">
        Nothing new starts on this project until an Owner or Admin resumes it. Shifts already running finish;
        cards keep their place in the queue and agents pick them up again at resume.
      </p>
      {paused.reason && (
        <p className="mt-1 text-sm" data-testid="project-paused-reason">
          Reason: {paused.reason}
        </p>
      )}
      <ErrorBox error={resume.error} />
    </Callout>
  );
}

/** A small badge for lists of projects. */
export function PausedBadge({ project }: { project: Pick<ProjectDto, 'paused'> }) {
  if (!project.paused) return null;
  return (
    <Badge tone="warning" data-testid="project-paused-badge">
      Paused
    </Badge>
  );
}
