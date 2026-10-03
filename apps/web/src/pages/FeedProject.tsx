import { Link, useParams } from 'react-router';
import { useFeedList, useTaste } from '../api/queries/digest.ts';
import { useProjects } from '../api/queries/projects.ts';
import { useRunFeed, useSchedules } from '../api/queries/schedules.ts';
import { DigestItemRow } from '../components/DigestRating.tsx';
import { Button, ErrorBox, PageHeader, Panel, Spinner } from '../components/ui.tsx';
import { describeCron } from '../lib/feeds.ts';
import { formatDateTime } from '../lib/time.ts';

/** A feed project: run it now, its schedules, the running list (oldest first) and the taste.md preview. */
export function FeedProject() {
  const { projectKey = '' } = useParams();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.key === projectKey);
  const list = useFeedList(project?.id);
  const taste = useTaste(project?.id);
  const schedules = useSchedules(project?.id);
  const run = useRunFeed();

  if (projects.isPending) return <Spinner />;
  if (!project) return <p className="text-sm text-zinc-500">Project {projectKey} not found.</p>;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-3">
      <PageHeader
        title={`${project.name} feed`}
        sub={project.key}
        actions={
          <>
            <Link
              to={`/p/${project.key}/board`}
              className="inline-flex min-h-8 items-center rounded-md border border-zinc-300 px-3 py-1 text-sm font-medium dark:border-zinc-700"
            >
              Board
            </Link>
            <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate(project.id)}>
              Run now
            </Button>
          </>
        }
      />
      <ErrorBox error={run.error} />
      {run.data && (
        <p className="text-sm" data-testid="run-result">
          Emitted{' '}
          <Link to={`/cards/${run.data.ref}`} className="underline">
            {run.data.ref}
          </Link>
          ; the next free scout picks it up first.
        </p>
      )}

      <Panel>
        <h2 className="mb-1 text-sm font-semibold">Schedules</h2>
        {(schedules.data ?? []).length === 0 ? (
          <p className="text-sm text-zinc-500">
            No schedule.{' '}
            <Link to="/schedules" className="underline">
              Add one
            </Link>
            .
          </p>
        ) : (
          <ul className="text-sm">
            {schedules.data?.map((s) => (
              <li key={s.id}>
                {s.name}: {describeCron(s.cron)} ({s.timezone}), next{' '}
                {s.nextFireAt ? formatDateTime(s.nextFireAt) : 'not scheduled'}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <h2 className="mb-1 text-sm font-semibold">Running list</h2>
        <p className="mb-2 text-xs text-zinc-500">
          {list.data?.path} · oldest first, entries are only ever appended
        </p>
        {list.isPending && <Spinner />}
        {list.data?.items.length === 0 && (
          <p className="text-sm text-zinc-500" data-testid="feed-empty">
            Nothing logged yet.
          </p>
        )}
        <ol className="flex flex-col gap-2" data-testid="feed-list">
          {list.data?.items.map((i) => (
            <li key={i.id}>
              <DigestItemRow item={i} canRate />
            </li>
          ))}
        </ol>
      </Panel>

      <Panel>
        <h2 className="mb-1 text-sm font-semibold">taste.md</h2>
        <p className="mb-2 text-xs text-zinc-500">
          {taste.data?.path} · explicit rules from your ratings; curators read this before filtering
        </p>
        {taste.data?.content ? (
          <pre
            className="overflow-x-auto rounded-md bg-zinc-50 p-2 text-xs whitespace-pre-wrap dark:bg-zinc-950"
            data-testid="taste-preview"
          >
            {taste.data.content}
          </pre>
        ) : (
          <p className="text-sm text-zinc-500" data-testid="taste-empty">
            No ratings yet.
          </p>
        )}
      </Panel>
    </div>
  );
}
