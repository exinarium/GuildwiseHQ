import { CheckCircle2, Circle, Hammer } from 'lucide-react';
import { useState } from 'react';
import { useAgents } from '../api/queries/agents.ts';
import { useProject } from '../api/queries/projects.ts';
import { useWorkstations } from '../api/queries/workstations.ts';
import { useCanConvert } from '../lib/projectWorkflow.ts';
import { ConvertProjectDialog } from './ConvertProjectDialog.tsx';
import { Button, ButtonLink, Dialog } from './ui.tsx';
import type { ProjectDto } from '@aom/shared';

/**
 * "Build something", for a project in the Business view: a friendly way into software work without switching view.
 * It is a short checklist over the existing flows: a workstation (the machine that runs the work), the project's
 * conversion to a software project (which is where its repository is chosen) and a builder. Each step links to the
 * page that already does it. Nothing is installed or changed until the person completes a step.
 */
export function BuildSomething({ project }: { project: ProjectDto }) {
  const [open, setOpen] = useState(false);
  const [converting, setConverting] = useState(false);
  const stations = useWorkstations({ enabled: open });
  const detail = useProject(open || converting ? project.id : undefined);
  const agents = useAgents(undefined, undefined);
  const canConvert = useCanConvert(project);

  const hasStation = (stations.data ?? []).some((w) => w.status === 'active');
  const repos = (detail.data?.repos ?? []).filter((r) => !r.removedAt);
  const hasBuilder = (agents.data ?? []).some((a) => a.roleKey === 'builder' && a.status === 'active');

  const step = (done: boolean, title: string, hint: string, action: React.ReactNode, id: string) => (
    <li className="flex items-start gap-3 py-3" data-testid={`build-step-${id}`} data-done={done}>
      {done ? (
        <CheckCircle2 aria-label="Done" className="mt-0.5 size-5 shrink-0 text-success" />
      ) : (
        <Circle aria-label="To do" className="mt-0.5 size-5 shrink-0 text-subtle" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-base font-medium text-fg">{title}</span>
        <span className="block text-sm text-muted">{hint}</span>
      </span>
      {!done && action}
    </li>
  );

  return (
    <>
      <Button data-testid="build-something-open" onClick={() => setOpen(true)}>
        <Hammer aria-hidden="true" className="size-4" />
        Build something
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Build something"
        description="Turn this project into one that builds software. Three short steps; you stay in your current view and nothing changes until you finish a step."
        size="lg"
      >
        <ol className="divide-y divide-line" data-testid="build-steps">
          {step(
            hasStation,
            'A workstation',
            'The computer that runs the work, yours or a server you rent.',
            <ButtonLink to="/workstations?add=1" data-testid="build-workstation">
              Add a workstation
            </ButtonLink>,
            'workstation',
          )}
          {step(
            repos.length > 0,
            'A repository',
            'Where the code lives. Making this a software project lets you connect or create one.',
            canConvert && detail.data ? (
              <Button
                data-testid="build-convert"
                onClick={() => {
                  setOpen(false);
                  setConverting(true);
                }}
              >
                Make it a software project
              </Button>
            ) : (
              <span className="text-xs text-subtle">Ask an Owner or Admin</span>
            ),
            'repository',
          )}
          {step(
            hasBuilder,
            'A builder',
            'The agent that writes the code.',
            <ButtonLink
              to={`/agents?hire=builder&projectId=${project.id}`}
              data-testid="build-builder"
              onClick={() => setOpen(false)}
            >
              Hire a builder
            </ButtonLink>,
            'builder',
          )}
        </ol>
      </Dialog>
      {detail.data && (
        <ConvertProjectDialog
          project={detail.data.project}
          repos={detail.data.repos}
          open={converting}
          onOpenChange={setConverting}
        />
      )}
    </>
  );
}
