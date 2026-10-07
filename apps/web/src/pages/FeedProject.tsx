import { Rss } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useFeedList, useTaste } from '../api/queries/digest.ts';
import { useInterest, useInterestDigestItems } from '../api/queries/interests.ts';
import { useProjects } from '../api/queries/projects.ts';
import { useRunFeed, useSchedules } from '../api/queries/schedules.ts';
import { DigestItemRow } from '../components/DigestRating.tsx';
import {
  Button,
  ButtonLink,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  PageSkeleton,
  Panel,
  useToast,
} from '../components/ui.tsx';
import { describeCron } from '../lib/feeds.ts';
import { formatDateTime } from '../lib/time.ts';

/** A feed project: run it now, its schedules, the running list (oldest first) and the taste.md preview. */
export function FeedProject() {
  const { projectKey = '' } = useParams();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.key === projectKey);
  const list = useFeedList(project?.id);
  // /p/KEY/feed?interest=<id> shows only the scans of one interest (the Digests link on the Interests page).
  const [params, setParams] = useSearchParams();
  const interestId = params.get('interest');
  const interest = useInterest(interestId ?? undefined);
  const filtered = useInterestDigestItems(project?.id, interestId);
  const items = interestId ? filtered.data : list.data?.items;
  const taste = useTaste(project?.id);
  const schedules = useSchedules(project?.id);
  const run = useRunFeed();
  const toast = useToast();

  if (projects.isPending) return <PageSkeleton label="Loading the feed" />;
  if (!project)
    return (
      <EmptyState
        icon={Rss}
        tone="warning"
        title="That feed does not exist"
        description={`Nothing is called ${projectKey}, or you do not have access to it.`}
        action={
          <ButtonLink to="/projects" variant="primary">
            Browse projects
          </ButtonLink>
        }
      />
    );

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <PageHeader
        title={`${project.name} feed`}
        sub={project.key}
        actions={
          <>
            <ButtonLink to={`/p/${project.key}/board`}>Board</ButtonLink>
            <Button
              variant="primary"
              loading={run.isPending}
              onClick={() =>
                run.mutate(project.id, {
                  onSuccess: (r) => toast.success(`Emitted ${r.ref}. The next scout picks it up.`),
                })
              }
            >
              Run now
            </Button>
          </>
        }
      />
      <ErrorBox error={run.error} />
      {run.data && (
        <p className="text-sm text-fg" data-testid="run-result">
          Emitted{' '}
          <Link to={`/cards/${run.data.ref}`} className="text-brand-text underline">
            {run.data.ref}
          </Link>
          ; the next free scout picks it up first.
        </p>
      )}

      <Panel>
        <h2 className="mb-2 text-lg font-semibold text-fg">Schedules</h2>
        {(schedules.data ?? []).length === 0 ? (
          <p className="text-sm text-muted">
            No schedule.{' '}
            <Link to="/schedules" className="text-brand-text underline">
              Add one
            </Link>
            .
          </p>
        ) : (
          <ul className="divide-y divide-line text-sm text-fg">
            {schedules.data?.map((s) => (
              <li key={s.id} className="py-2 first:pt-0 last:pb-0">
                {s.name}: {describeCron(s.cron ?? '')} ({s.timezone}), next{' '}
                {s.nextFireAt ? formatDateTime(s.nextFireAt) : 'not scheduled'}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <h2 className="mb-2 text-lg font-semibold text-fg">Running list</h2>
        <p className="mb-3 font-mono text-xs text-subtle">
          {list.data?.path} · oldest first, entries are only ever appended
        </p>
        {list.isPending && <ListSkeleton label="Loading the running list" rows={3} />}
        {interestId && (
          <p className="mb-2 flex items-center gap-2 text-sm" data-testid="interest-filter-chip">
            <span className="rounded-full bg-sunken px-2 py-0.5 text-xs">
              Interest: {interest.data?.interest.name ?? '...'}
            </span>
            <button
              type="button"
              className="text-xs underline"
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete('interest');
                setParams(next);
              }}
            >
              Clear
            </button>
          </p>
        )}
        {items?.length === 0 && (
          <EmptyState
            bare
            data-testid="feed-empty"
            icon={Rss}
            title="Nothing logged yet"
            description="Run the scan now, or wait for the next schedule. Each digest lands here for you to rate."
          />
        )}
        <ol className="flex flex-col gap-2" data-testid="feed-list">
          {items?.map((i) => (
            <li key={i.id}>
              <DigestItemRow item={i} canRate />
            </li>
          ))}
        </ol>
      </Panel>

      <Panel>
        <h2 className="mb-2 text-lg font-semibold text-fg">taste.md</h2>
        <p className="mb-3 font-mono text-xs text-subtle">
          {taste.data?.path} · explicit rules from your ratings; curators read this before filtering
        </p>
        {taste.data?.content ? (
          <pre
            className="overflow-x-auto rounded-control bg-sunken p-3 font-mono text-xs whitespace-pre-wrap text-fg"
            data-testid="taste-preview"
          >
            {taste.data.content}
          </pre>
        ) : (
          <p className="text-sm text-muted" data-testid="taste-empty">
            No ratings yet. Rate a few items above and the rules appear here.
          </p>
        )}
      </Panel>
    </div>
  );
}
