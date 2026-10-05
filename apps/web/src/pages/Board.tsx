import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useBoard } from '../api/queries/board.ts';
import { usePhases } from '../api/queries/phases.ts';
import { useProjects } from '../api/queries/projects.ts';
import { useRunFeed } from '../api/queries/schedules.ts';
import { BoardView } from '../components/BoardView.tsx';
import { PhaseFilter } from '../components/PhaseFilter.tsx';
import { RegressionDialog } from '../components/RegressionDialog.tsx';
import { Button, ErrorBox, PageHeader, Spinner } from '../components/ui.tsx';
import { departmentsOf, inDepartment } from '../lib/designer.ts';
import { setLastProjectKey } from '../lib/lastProject.ts';
import { useProjectWorkflowTraits } from '../lib/projectWorkflow.ts';

export function Board() {
  const { projectKey = '' } = useParams();
  const nav = useNavigate();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.key === projectKey);
  const [phaseId, setPhaseId] = useState('');
  const board = useBoard(project?.id, phaseId || undefined);
  const phases = usePhases(project?.id);
  const runFeed = useRunFeed();
  const [department, setDepartment] = useState('');
  const traits = useProjectWorkflowTraits(project?.id, project?.workflowKey);

  useEffect(() => {
    if (project) setLastProjectKey(project.key);
  }, [project]);

  if (projects.isPending) return <Spinner />;
  if (projects.isError) return <ErrorBox error={projects.error} />;
  if (!project) {
    return (
      <div>
        <PageHeader title="Board" />
        <p className="text-sm text-zinc-500">
          Project {projectKey} not found.{' '}
          <Link to="/projects" className="underline">
            Browse projects
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={`${project.name} board`}
        sub={project.key}
        actions={
          <>
            <label className="sr-only" htmlFor="project-switch">
              Project
            </label>
            {departmentsOf(projects.data ?? []).length > 0 && (
              <>
                <label className="sr-only" htmlFor="department-filter">
                  Department
                </label>
                <select
                  id="department-filter"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <option value="">All departments</option>
                  {departmentsOf(projects.data ?? []).map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </>
            )}
            <select
              id="project-switch"
              value={project.key}
              onChange={(e) => nav(`/p/${e.target.value}/board`)}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              {inDepartment(projects.data ?? [], department)
                .concat(
                  project && !inDepartment(projects.data ?? [], department).includes(project)
                    ? [project]
                    : [],
                )
                .map((p) => (
                  <option key={p.id} value={p.key}>
                    {p.key}
                  </option>
                ))}
            </select>
            <PhaseFilter phases={phases.data ?? []} value={phaseId} onChange={setPhaseId} />
            {traits.hasTestStage && <RegressionDialog projectId={project.id} />}
            {project.workflowKey === 'feed' && (
              <>
                <Link
                  to={`/p/${project.key}/feed`}
                  className="inline-flex min-h-8 items-center rounded-md border border-zinc-300 px-3 py-1 text-sm font-medium dark:border-zinc-700"
                >
                  Feed
                </Link>
                <Button disabled={runFeed.isPending} onClick={() => runFeed.mutate(project.id)}>
                  Run now
                </Button>
              </>
            )}
            <Link
              to={`/cards/new?project=${project.key}`}
              className="inline-flex min-h-8 items-center rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500"
            >
              New card
            </Link>
          </>
        }
      />
      <ErrorBox error={runFeed.error} />
      {board.isPending && <Spinner label="Loading board" />}
      {board.isError && <ErrorBox error={board.error} />}
      {board.data && <BoardView board={board.data} />}
    </div>
  );
}
