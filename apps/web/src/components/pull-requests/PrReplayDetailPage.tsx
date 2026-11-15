import { replayFailureText } from '@aom/shared';
import { useState } from 'react';
import { useParams } from 'react-router';
import {
  useCancelReplay,
  useReplay,
  useReplayFindings,
  useRetryReplay,
} from '../../api/queries/pr-replays.ts';
import { useProject, useProjects } from '../../api/queries/projects.ts';
import { ProjectTabs } from '../ProjectTabs.tsx';
import { ErrorBox, ListSkeleton, PageHeader } from '../ui.tsx';
import { FindingMark } from './FindingMark.tsx';
import { ReplayMarkingQueue } from './ReplayMarkingQueue.tsx';
import { ReplayResults } from './ReplayResults.tsx';
import { ReviewTargetsForm } from './ReviewTargetsForm.tsx';

function Findings({ replayId, held }: { replayId: string; held: boolean }) {
  const q = useReplayFindings(replayId, true, held);
  if (q.isPending) return <p role="status">Loading…</p>;
  if (q.isError) return <ErrorBox error={q.error} />;
  return (
    <ul className="space-y-2" aria-label={held ? 'Held-back findings' : 'Findings'}>
      {q.data.findings.map((f) => (
        <li key={f.id} className="rounded-control border border-border p-2">
          <p className="break-words font-medium">
            [{f.severity}] {f.title}
          </p>
          <p className="break-words text-muted">
            {f.path}
            {f.line != null ? `:${f.line}` : ''}
          </p>
          {!held && <FindingMark finding={f} onMark={() => undefined} />}
        </li>
      ))}
    </ul>
  );
}

/** One replay by state: progress, blind marking, or the result with the targets form. */
export function PrReplayDetailPage() {
  const { projectKey = '', replayId = '' } = useParams();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.key === projectKey);
  const detail = useProject(project?.id);
  const q = useReplay(replayId);
  const cancel = useCancelReplay(replayId);
  const retry = useRetryReplay(replayId);
  const [showHeld, setShowHeld] = useState(false);
  if (!project) return <PageHeader title="20-PR replay" />;
  const r = q.data;
  const behind = r ? r.progress.runsTotal - r.progress.runsDone : 0;
  return (
    <div>
      <PageHeader title={project.name} documentTitle={`${project.name} replay`} sub="20-PR replay" />
      <ProjectTabs projectKey={project.key} projectId={project.id} active="pull-requests" />
      {q.isPending ? (
        <ListSkeleton />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : !r ? null : (
        <div className="space-y-4">
          {(r.state === 'listing' || r.state === 'reviewing') && (
            <section aria-label="Progress" data-testid="replay-progress">
              <p role="status">
                {r.state === 'listing'
                  ? 'Listing the merged pull requests…'
                  : `Reviewing: ${r.progress.runsDone} of ${r.progress.runsTotal} reviews done${r.progress.runsFailed ? ` (${r.progress.runsFailed} failed)` : ''}`}
              </p>
              {r.canManage && (
                <button
                  type="button"
                  onClick={() => cancel.mutate()}
                  className="inline-flex min-h-11 items-center rounded-control border border-border px-4"
                >
                  Cancel replay
                </button>
              )}
            </section>
          )}
          {r.state === 'failed' && r.failure && <p role="alert">{replayFailureText(r.failure)}</p>}
          {r.state === 'cancelled' && <p>This replay was cancelled.</p>}
          {r.state === 'marking' && (
            <>
              {behind > 0 && (
                <p>
                  {behind} review{behind === 1 ? '' : 's'} did not finish.{' '}
                  {r.canManage && (
                    <button
                      type="button"
                      onClick={() => retry.mutate()}
                      className="inline-flex min-h-11 items-center text-brand-text underline"
                    >
                      Retry missing reviews
                    </button>
                  )}
                </p>
              )}
              {r.canManage ? <ReplayMarkingQueue replayId={r.id} /> : <p>The owner marks the findings.</p>}
              <button
                type="button"
                aria-expanded={showHeld}
                onClick={() => setShowHeld((s) => !s)}
                className="inline-flex min-h-11 items-center text-brand-text underline"
              >
                {showHeld ? 'Hide held-back findings' : 'Show held-back findings'}
              </button>
              {showHeld && <Findings replayId={r.id} held />}
            </>
          )}
          {r.state === 'finished' && (
            <>
              <ReplayResults replay={r} />
              <ReviewTargetsForm
                projectId={project.id}
                canManage={r.canManage}
                result={r.result}
                saved={detail.data?.project?.reviewTargets}
              />
              <h2 className="font-semibold">Findings</h2>
              <Findings replayId={r.id} held={false} />
            </>
          )}
          <ul className="space-y-1" aria-label="Pull requests in the replay">
            {r.prs.map((p) => (
              <li key={p.id} className="break-words">
                <a
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center text-brand-text underline"
                >
                  #{p.changeId} {p.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
