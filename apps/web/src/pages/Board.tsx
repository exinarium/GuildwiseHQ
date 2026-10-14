import { ArrowRightLeft, Search, Settings, SquareKanban } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router';
import { useMe } from '../api/queries/auth.ts';
import { useBoard } from '../api/queries/board.ts';
import { useInterests } from '../api/queries/interests.ts';
import { usePhases } from '../api/queries/phases.ts';
import { useProject, useProjects } from '../api/queries/projects.ts';
import { BoardView, NO_FILTER } from '../components/BoardView.tsx';
import { BudgetBanner } from '../components/BudgetBanner.tsx';
import { ConvertProjectDialog } from '../components/ConvertProjectDialog.tsx';
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
  PriorityPicker,
  Skeleton,
} from '../components/ui.tsx';
import { RunBranchDialog } from '../components/runs/RunBranchDialog.tsx';
import { RunList } from '../components/runs/RunPanel.tsx';
import { useRuns } from '../api/queries/runs.ts';
import { setLastProjectKey } from '../lib/lastProject.ts';
import { money } from '../lib/money.ts';
import { useCanConvert, useProjectWorkflowTraits } from '../lib/projectWorkflow.ts';

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
  // The key of an interest's hidden project is not a project: its board is the interest.
  const interests = useInterests();
  const interestOfKey = project
    ? undefined
    : interests.data?.interests.find((i) => i.projectKey === projectKey);
  const [phaseId, setPhaseId] = useState('');
  const board = useBoard(project?.id, phaseId || undefined);
  const phases = usePhases(project?.id);
  const traits = useProjectWorkflowTraits(project?.id, project?.workflowKey);
  const [filter, setFilter] = useState(NO_FILTER);
  const me = useMe();
  const [converting, setConverting] = useState(false);
  const detail = useProject(project?.workflowKey === 'research' ? project.id : undefined);
  const canConvert = useCanConvert(project);
  const runs = useRuns({ projectId: project?.id }, { enabled: !!project?.id });

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
  if (!project && interestOfKey) return <Navigate to={`/interests/${interestOfKey.id}`} replace />;
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
  const myId = me.data?.user?.id;
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
            {project.budget?.spentMicros !== null && project.budget?.spentMicros !== undefined && (
              <span data-testid="board-spend">
                {' · '}
                {money(project.budget.spentMicros, project.budget.currency)}
                {project.budget.monthlyMicros !== null &&
                  ` of ${money(project.budget.monthlyMicros, project.budget.currency)}`}
                {' this month'}
              </span>
            )}
          </span>
        }
        actions={
          <>
            <PhaseFilter phases={phases.data ?? []} value={phaseId} onChange={setPhaseId} />
            {traits.usesRepos && <RunBranchDialog projectId={project.id} />}
            {traits.hasTestStage && <RegressionDialog projectId={project.id} />}
            {project.workflowKey === 'research' && canConvert && detail.data && (
              <Button data-testid="convert-board-open" onClick={() => setConverting(true)}>
                <ArrowRightLeft aria-hidden="true" className="size-4" />
                Convert to project
              </Button>
            )}
            <ButtonLink to={`/p/${project.key}/archive`} variant="ghost">
              Archive
            </ButtonLink>
            <ButtonLink
              to={`/projects/${project.id}/settings`}
              variant="ghost"
              aria-label={`Settings for ${project.key}`}
              title="Project settings"
            >
              <Settings aria-hidden="true" className="size-4" />
            </ButtonLink>
            <ButtonLink to={`/cards/new?project=${project.key}`} variant="primary">
              New card
            </ButtonLink>
          </>
        }
      />
      <BudgetBanner
        budget={project.budget}
        projectId={project.id}
        name={project.key}
        settingsTo={`/projects/${project.id}/settings#budget`}
      />
      {detail.data && (
        <ConvertProjectDialog
          project={detail.data.project}
          repos={detail.data.repos}
          open={converting}
          onOpenChange={setConverting}
        />
      )}
      {runs.data && runs.data.length > 0 && (
        <div className="mb-3" data-testid="board-runs">
          <RunList envs={runs.data} />
        </div>
      )}
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
          {myId && cards.some((c) => c.qa) && (
            <FilterChip
              pressed={filter.qaFor !== null}
              onClick={() => setF({ qaFor: filter.qaFor === null ? myId : null })}
            >
              Waiting for my QA ({cards.filter((c) => c.qa?.assigneeUserId === myId).length})
            </FilterChip>
          )}
        </div>
        <PriorityPicker
          allowAny
          inline
          label="Priority"
          value={filter.priority}
          onChange={(n) => setF({ priority: n })}
        />
      </div>
      {board.isPending && <BoardSkeleton />}
      {board.isError && <ErrorBox error={board.error} onRetry={() => board.refetch()} />}
      {board.data && cards.length === 0 && !phaseId && (
        <EmptyState
          data-testid="board"
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
