import { Rss, Search, Settings2, SquareKanban } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useBoard } from '../api/queries/board.ts';
import { usePhases } from '../api/queries/phases.ts';
import { useProjects } from '../api/queries/projects.ts';
import { useRunFeed } from '../api/queries/schedules.ts';
import { BoardView, NO_FILTER } from '../components/BoardView.tsx';
import { PhaseFilter } from '../components/PhaseFilter.tsx';
import { RegressionDialog } from '../components/RegressionDialog.tsx';
import { projectTypeLabel } from '../components/shell/ProjectSwitcher.tsx';
import {
  Button,
  ButtonLink,
  EmptyState,
  ErrorBox,
  FilterChip,
  PageHeader,
  Skeleton,
  useToast,
} from '../components/ui.tsx';
import { setLastProjectKey } from '../lib/lastProject.ts';
import { useProjectWorkflowTraits } from '../lib/projectWorkflow.ts';

function BoardSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading board...</span>
      <div aria-hidden="true" className="flex gap-3 overflow-hidden">
        {[
          { id: 'a', n: 3 },
          { id: 'b', n: 2 },
          { id: 'c', n: 3 },
          { id: 'd', n: 2 },
          { id: 'e', n: 1 },
        ].map(({ id, n }) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder
          <div key={id} className="w-[17rem] shrink-0 space-y-2 rounded-card bg-sunken p-2">
            <Skeleton className="h-5 w-1/2" />
            {['a', 'b', 'c'].slice(0, n).map((j) => (
              <Skeleton key={`${id}${j}`} className="h-20 rounded-card bg-surface" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Board() {
  const { projectKey = '' } = useParams();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.key === projectKey);
  const [phaseId, setPhaseId] = useState('');
  const board = useBoard(project?.id, phaseId || undefined);
  const phases = usePhases(project?.id);
  const runFeed = useRunFeed();
  const traits = useProjectWorkflowTraits(project?.id, project?.workflowKey);
  const [filter, setFilter] = useState(NO_FILTER);
  const toast = useToast();

  useEffect(() => {
    if (project) setLastProjectKey(project.key);
  }, [project]);

  if (projects.isPending)
    return (
      <>
        <PageHeader title="Board" />
        <BoardSkeleton />
      </>
    );
  if (projects.isError)
    return (
      <>
        <PageHeader title="Board" />
        <ErrorBox error={projects.error} onRetry={() => projects.refetch()} />
      </>
    );
  if (!project) {
    return (
      <>
        <PageHeader title="Board" />
        <EmptyState
          icon={SquareKanban}
          tone="warning"
          title="That project does not exist or you do not have access"
          description={`Nothing is called ${projectKey}. Pick one of your projects instead.`}
          action={
            <ButtonLink to="/projects" variant="primary">
              Browse projects
            </ButtonLink>
          }
        />
      </>
    );
  }

  const cards = board.data?.columns.flatMap((c) => c.cards) ?? [];
  const blocked = cards.filter((c) => c.blocked).length;
  const open = board.data
    ? board.data.columns.filter((c) => c.name !== 'Done').reduce((n, c) => n + c.cards.length, 0)
    : null;
  const setF = (patch: Partial<typeof filter>) => setFilter((f) => ({ ...f, ...patch }));

  return (
    <div>
      <PageHeader
        title={project.name}
        documentTitle={`${project.name} board`}
        sub={
          <span className="tnum">
            {project.key} · {projectTypeLabel(project.workflowKey)}
            {open !== null && ` · ${open} open`}
            {blocked > 0 && ` · ${blocked} blocked`}
          </span>
        }
        actions={
          <>
            <PhaseFilter phases={phases.data ?? []} value={phaseId} onChange={setPhaseId} />
            {traits.hasTestStage && <RegressionDialog projectId={project.id} />}
            {project.workflowKey === 'feed' && (
              <>
                <ButtonLink to={`/p/${project.key}/feed`}>
                  <Rss aria-hidden="true" className="size-4" />
                  Feed
                </ButtonLink>
                <Button
                  loading={runFeed.isPending}
                  onClick={() =>
                    runFeed.mutate(project.id, { onSuccess: () => toast.success('Feed scan started') })
                  }
                >
                  Run now
                </Button>
              </>
            )}
            <ButtonLink
              to={`/projects/${project.id}/settings`}
              variant="ghost"
              aria-label={`Settings for ${project.key}`}
              title="Project settings"
            >
              <Settings2 aria-hidden="true" className="size-4" />
            </ButtonLink>
            <ButtonLink to={`/cards/new?project=${project.key}`} variant="primary">
              New card
            </ButtonLink>
          </>
        }
      />
      <ErrorBox error={runFeed.error} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search
            aria-hidden="true"
            className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle"
          />
          <input
            type="search"
            aria-label="Search cards"
            placeholder="Search cards"
            value={filter.text}
            onChange={(e) => setF({ text: e.target.value })}
            onKeyDown={(e) => e.key === 'Escape' && setF({ text: '' })}
            className="h-9 w-full rounded-control border border-control bg-surface pr-3 pl-9 text-base text-fg placeholder:text-subtle focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:outline-none [@media(pointer:coarse)]:h-11"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto" role="group" aria-label="Filters">
          <FilterChip pressed={filter.blocked} onClick={() => setF({ blocked: !filter.blocked })}>
            Blocked
          </FilterChip>
          <FilterChip pressed={filter.rework} onClick={() => setF({ rework: !filter.rework })}>
            Rework
          </FilterChip>
          <FilterChip pressed={filter.unassigned} onClick={() => setF({ unassigned: !filter.unassigned })}>
            Unassigned
          </FilterChip>
        </div>
      </div>
      {board.isPending && <BoardSkeleton />}
      {board.isError && <ErrorBox error={board.error} onRetry={() => board.refetch()} />}
      {board.data && cards.length === 0 && !phaseId && (
        <EmptyState
          icon={SquareKanban}
          title="No cards yet"
          description="Create the first card, or bring work in from Jira or GitHub."
          action={
            <ButtonLink to={`/cards/new?project=${project.key}`} variant="primary">
              New card
            </ButtonLink>
          }
          secondaryAction={<ButtonLink to="/intake">Start an intake</ButtonLink>}
        />
      )}
      {board.data && (cards.length > 0 || phaseId) && <BoardView board={board.data} filter={filter} />}
    </div>
  );
}
