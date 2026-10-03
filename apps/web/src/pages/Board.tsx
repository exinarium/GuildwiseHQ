import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useBoard } from '../api/queries/board.ts';
import { useProjects } from '../api/queries/projects.ts';
import { BoardView } from '../components/BoardView.tsx';
import { ErrorBox, PageHeader, Spinner } from '../components/ui.tsx';
import { setLastProjectKey } from '../lib/lastProject.ts';

export function Board() {
  const { projectKey = '' } = useParams();
  const nav = useNavigate();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.key === projectKey);
  const board = useBoard(project?.id);

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
            <select
              id="project-switch"
              value={project.key}
              onChange={(e) => nav(`/p/${e.target.value}/board`)}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              {projects.data?.map((p) => (
                <option key={p.id} value={p.key}>
                  {p.key}
                </option>
              ))}
            </select>
            <Link
              to={`/cards/new?project=${project.key}`}
              className="inline-flex min-h-8 items-center rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500"
            >
              New card
            </Link>
          </>
        }
      />
      {board.isPending && <Spinner label="Loading board" />}
      {board.isError && <ErrorBox error={board.error} />}
      {board.data && <BoardView board={board.data} />}
    </div>
  );
}
