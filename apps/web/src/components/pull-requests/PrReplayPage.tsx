import { replayFailureText } from '@aom/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useReplays, useStartReplay } from '../../api/queries/pr-replays.ts';
import { useProject, useProjects } from '../../api/queries/projects.ts';
import { ProjectTabs } from '../ProjectTabs.tsx';
import { Badge, ErrorBox, ListSkeleton, PageHeader } from '../ui.tsx';

/** Past replays of the project and, for the owner, the start panel. */
export function PrReplayPage() {
  const { projectKey = '' } = useParams();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.key === projectKey);
  const detail = useProject(project?.id);
  const list = useReplays(project?.id);
  const start = useStartReplay(project?.id ?? '');
  const repos = (detail.data?.repos ?? []).filter((r) => r.prOnly && !r.removedAt);
  const [repoId, setRepoId] = useState('');
  if (!project) return <PageHeader title="20-PR replay" />;
  const chosen = repoId || repos[0]?.id || '';
  const replays = list.data?.replays ?? [];
  const activeReplay = replays.some((r) => ['listing', 'reviewing', 'marking'].includes(r.state));
  const isOwner = project.myRole === 'owner';
  return (
    <div>
      <PageHeader
        title={project.name}
        documentTitle={`${project.name} 20-PR replay`}
        sub="Measure both reviewers offline."
      />
      <ProjectTabs projectKey={project.key} projectId={project.id} active="pull-requests" />
      {isOwner && (
        <section
          aria-label="Start a replay"
          className="mb-4 space-y-2 rounded-control border border-border p-3"
        >
          {repos.length > 1 ? (
            <label className="block">
              <span className="font-medium">Repository</span>
              <select
                value={chosen}
                onChange={(e) => setRepoId(e.target.value)}
                className="mt-1 block min-h-11 w-full rounded-control border border-border px-2"
              >
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p>{repos[0] ? `Repository: ${repos[0].name}` : 'No PR-only repository.'}</p>
          )}
          <p className="text-muted">
            Runs 40 offline reviews (Sonnet and Opus on the 20 most recently merged pull requests) on your
            workstation. Nothing is posted to the pull requests. This can take several hours.
          </p>
          <button
            type="button"
            disabled={!chosen || activeReplay || start.isPending}
            onClick={() => start.mutate(chosen)}
            className="inline-flex min-h-11 items-center rounded-control border border-border px-4 font-medium disabled:opacity-60"
          >
            Start replay
          </button>
          {start.isError && <ErrorBox error={start.error} />}
        </section>
      )}
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
      ) : replays.length === 0 ? (
        <p>No replay has run yet.</p>
      ) : (
        <ul className="space-y-2" aria-label="Replays">
          {replays.map((r) => (
            <li key={r.id} className="rounded-control border border-border p-3">
              <Link
                to={`/p/${project.key}/pull-requests/replay/${r.id}`}
                className="inline-flex min-h-11 items-center text-brand-text underline"
              >
                {r.repoName || 'Replay'} · {new Date(r.startedAt).toLocaleString()}
              </Link>{' '}
              <Badge tone={r.state === 'finished' ? 'green' : r.state === 'failed' ? 'red' : 'neutral'}>
                {r.state}
              </Badge>
              {r.failure && <p className="text-muted">{replayFailureText(r.failure)}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
