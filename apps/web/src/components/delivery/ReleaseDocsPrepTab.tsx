import type { ReleaseDocsPrepOverviewItem, ReleaseDocsPrepRunDto } from '@aom/shared';
import { useState } from 'react';
import {
  useReleaseDocsPrepOverview,
  useRetryReleaseDocsPrep,
  useRunReleaseDocsPrep,
  useSkipReleaseDocsPrep,
} from '../../api/queries/releaseDocsPrep.ts';
import { formatDate } from '../../lib/time.ts';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { Badge, Button, Callout, ErrorBox, Panel, Spinner } from '../ui.tsx';
import { ChangelogStepOutput } from './ChangelogStepOutput.tsx';

const TONE = {
  off: 'neutral',
  not_run: 'neutral',
  running: 'info',
  passed: 'success',
  failed: 'danger',
  skipped: 'warning',
} as const;
const LABEL = {
  off: 'off',
  not_run: 'not run',
  running: 'running',
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
} as const;
const short = (s: string | null): string => (s ? s.slice(0, 7) : '');

/** Release prep (docs and videos): per project and release branch, the state, each step per repository and its output. */
export function ReleaseDocsPrepTab() {
  const q = useReleaseDocsPrepOverview();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (q.data.length === 0) return null;
  return (
    <div className="flex flex-col gap-4" data-testid="release-docs-prep-tab">
      {q.data.map((item) => (
        <ProjectPrep key={item.projectId} item={item} />
      ))}
    </div>
  );
}

function ProjectPrep({ item }: { item: ReleaseDocsPrepOverviewItem }) {
  const run = useRunReleaseDocsPrep(item.projectId);
  const retry = useRetryReleaseDocsPrep(item.projectId);
  const skip = useSkipReleaseDocsPrep(item.projectId);
  const [confirm, setConfirm] = useState(false);
  const r = item.run;
  const canRun =
    item.canAct && (item.state === 'not_run' || item.state === 'passed' || item.state === 'skipped');
  const canSkip =
    item.canAct && (item.state === 'not_run' || item.state === 'running' || item.state === 'failed');
  const error = run.error ?? retry.error ?? skip.error;
  return (
    <div id={`release-docs-prep-${item.projectId}`} className="scroll-mt-20">
      <Panel
        title={`${item.name}${item.releaseBranch ? ` · ${item.releaseBranch}` : ''}`}
        data-testid={`release-docs-prep-${item.key}`}
        actions={
          <Badge tone={TONE[item.state]} data-testid="release-docs-prep-state">
            {LABEL[item.state]}
          </Badge>
        }
      >
        <div className="flex flex-col gap-3">
          {!item.enabled && (
            <Callout tone="info">Release prep (docs and videos) is switched off for this project.</Callout>
          )}
          {!item.canAct && item.enabled && (
            <p className="text-sm text-subtle">
              Only the project Owner or an organization Owner or Admin runs release prep.
            </p>
          )}
          {r && <RunView run={r} />}
          {item.state === 'not_run' && (
            <p className="text-sm text-subtle">Release prep has not run for this release yet.</p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap [&>button]:max-sm:w-full">
            {canRun && (
              <Button
                variant="primary"
                className="min-h-11 sm:min-h-0"
                loading={run.isPending}
                onClick={() => run.mutate()}
              >
                Run release prep
              </Button>
            )}
            {item.canAct && item.state === 'failed' && r && (
              <Button
                variant="primary"
                className="min-h-11 sm:min-h-0"
                loading={retry.isPending}
                onClick={() => retry.mutate(r.id)}
              >
                Retry prep
              </Button>
            )}
            {canSkip && (
              <Button className="min-h-11 sm:min-h-0" onClick={() => setConfirm(true)}>
                Skip prep for this release
              </Button>
            )}
          </div>
          <ErrorBox error={error} />
        </div>
      </Panel>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Skip release prep for this release?"
        description="The release can then ship exactly as it does without release prep. This is recorded with your name."
        confirmLabel="Skip prep"
        tone="primary"
        pending={skip.isPending}
        onConfirm={() => skip.mutate(undefined, { onSuccess: () => setConfirm(false) })}
      />
    </div>
  );
}

function RunView({ run }: { run: ReleaseDocsPrepRunDto }) {
  return (
    <div className="flex flex-col gap-3" data-testid="release-docs-prep-run">
      <p className="text-xs text-subtle">
        Started {formatDate(run.startedAt)}
        {run.finishedAt ? ` · finished ${formatDate(run.finishedAt)}` : ''}
        {run.trigger === 'retry' ? ' · a retry' : ''}
        {run.skippedAt ? ` · skipped ${formatDate(run.skippedAt)}` : ''}
      </p>
      {run.failed && (
        <Callout tone="danger" data-testid="release-docs-prep-failed" role="alert">
          Failed at {run.failed.step}
          {run.failed.repoName ? ` in ${run.failed.repoName}` : ''}: {run.failed.error}
        </Callout>
      )}
      {run.repos.map((repo) => (
        <div
          key={repo.repoId}
          className="rounded-control border border-line p-3"
          data-testid={`prep-repo-${repo.repoName}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg">{repo.repoName}</span>
            <span className="font-mono text-xs text-subtle">{repo.branch}</span>
            <Badge
              tone={
                TONE[
                  repo.state === 'pending'
                    ? 'not_run'
                    : repo.state === 'running'
                      ? 'running'
                      : repo.state === 'passed'
                        ? 'passed'
                        : repo.state === 'failed'
                          ? 'failed'
                          : 'skipped'
                ]
              }
            >
              {repo.state}
            </Badge>
          </div>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {repo.steps.map((s) => (
              <li key={`${s.step}-${s.phase}`} className="break-words">
                <span className="font-mono text-xs">
                  {s.step}
                  {s.phase ? ` (${s.phase})` : ''}
                </span>{' '}
                <span className="text-subtle">{s.state}</span>
                {s.error && <span className="block text-danger-soft-fg">{s.error}</span>}
                {s.step === 'changelog' && !s.error && (
                  <ChangelogStepOutput repoName={repo.repoName} state={s.state} output={s.output} />
                )}
              </li>
            ))}
          </ul>
          {repo.commitSha ? (
            <p className="mt-2 text-xs" data-testid="prep-commit">
              Commit <span className="font-mono">{short(repo.commitSha)}</span>
              {repo.pushed ? ' pushed to the release branch' : ' prepared, not pushed'}
            </p>
          ) : (
            run.status === 'passed' && (
              <p className="mt-2 text-xs text-subtle">No changes: nothing was committed.</p>
            )
          )}
          {repo.summary && (
            <details className="mt-2" data-testid="prep-summary">
              <summary className="min-h-11 cursor-pointer py-2 text-sm sm:min-h-0 sm:py-0">
                {repo.summary.commitCount} commits since{' '}
                {repo.summary.base.kind === 'tag' ? repo.summary.base.tag : repo.summary.base.branch}
              </summary>
              {repo.summary.cards.length > 0 && (
                <p className="mt-1 text-xs">Cards: {repo.summary.cards.map((c) => c.key).join(', ')}</p>
              )}
              <ul className="mt-1 text-xs">
                {repo.summary.areas.map((a) => (
                  <li key={a.area}>
                    {a.area}: {a.files} files ({a.added} added, {a.modified} changed, {a.deleted} removed)
                  </li>
                ))}
              </ul>
              <ul className="mt-1 text-xs">
                {repo.summary.commits.slice(0, 50).map((c) => (
                  <li key={c.sha} className="break-words">
                    <span className="font-mono">{short(c.sha)}</span> {c.subject}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
