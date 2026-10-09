import type { ProjectDetailResponse, ProjectRepoDto } from '@aom/shared';
import { useCheckEnvironment, useRetryRepoSetup } from '../api/queries/projects.ts';
import { Badge, Button, ErrorBox, Panel } from './ui.tsx';

type Tone = 'neutral' | 'blue' | 'amber' | 'green' | 'red';

const CLONE: Record<NonNullable<ProjectRepoDto['setup']>[number]['state'], { tone: Tone; label: string }> = {
  cloning: { tone: 'blue', label: 'Cloning' },
  cloned: { tone: 'green', label: 'Cloned' },
  created: { tone: 'green', label: 'Created and cloned' },
  failed: { tone: 'red', label: 'Failed' },
  needs_manager: { tone: 'amber', label: 'Needs you' },
};

/**
 * Where the DevOps engineers put a repository: one line per workstation of the project ("Cloning", "Cloned on Desk",
 * "Failed: reason"), and a retry when something did not work.
 */
export function RepoSetupStatus({
  projectId,
  repo,
  canRetry,
}: {
  projectId: string;
  repo: ProjectRepoDto;
  canRetry: boolean;
}) {
  const retry = useRetryRepoSetup(projectId);
  const rows = repo.setup ?? [];
  if (rows.length === 0) return null;
  const broken = rows.some((r) => r.state === 'failed' || r.state === 'needs_manager');
  return (
    <ul className="mt-2 flex flex-col gap-1" data-testid={`repo-setup-${repo.name}`}>
      {rows.map((r) => {
        const c = CLONE[r.state];
        return (
          <li
            key={r.workstationId}
            className="flex flex-wrap items-baseline gap-2 text-xs"
            data-state={r.state}
          >
            <Badge tone={c.tone}>{c.label}</Badge>
            <span className="text-muted">
              {r.state === 'cloned' || r.state === 'created' ? `on ${r.workstationName}` : r.workstationName}
            </span>
            {r.detail && r.state !== 'cloning' && (
              <span
                className={
                  r.state === 'failed' || r.state === 'needs_manager' ? 'text-danger' : 'text-subtle'
                }
              >
                {r.state === 'failed' ? `Failed: ${r.detail}` : r.detail}
              </span>
            )}
          </li>
        );
      })}
      {broken && canRetry && (
        <li>
          <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate(repo.id)}>
            Try again
          </Button>
        </li>
      )}
      <ErrorBox error={retry.error} />
    </ul>
  );
}

const ENV: Record<
  NonNullable<ProjectDetailResponse['environments']>[number]['state'],
  { tone: Tone; label: string }
> = {
  preparing: { tone: 'blue', label: 'Preparing' },
  ready: { tone: 'green', label: 'Ready' },
  failed: { tone: 'red', label: 'Not ready' },
  needs_access: { tone: 'amber', label: 'Needs access' },
};

const TOOL_TONE: Record<string, Tone> = {
  ok: 'green',
  installed: 'green',
  missing: 'red',
  failed: 'red',
  needs_access: 'amber',
  skipped: 'neutral',
};

/**
 * The development environment of the project per workstation: the DevOps engineer installs the toolchain the
 * repositories need (.NET and the MAUI workloads, Node, Python, Docker, ...) before build cards start there.
 */
export function EnvironmentPanel({
  projectId,
  environments,
  canCheck,
}: {
  projectId: string;
  environments: NonNullable<ProjectDetailResponse['environments']>;
  canCheck: boolean;
}) {
  const check = useCheckEnvironment(projectId);
  if (environments.length === 0) return null;
  return (
    <Panel title="Development environment">
      <p className="mb-3 text-sm text-muted">
        Before agents build here, the DevOps engineer of each workstation makes sure the tools the
        repositories need are installed. Build and test cards wait on a workstation until it is ready.
      </p>
      <ul className="flex flex-col divide-y divide-line" data-testid="environments">
        {environments.map((e) => {
          const s = ENV[e.state];
          return (
            <li key={e.workstationId} className="py-3 text-sm first:pt-0" data-state={e.state}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{e.workstationName}</span>
                <Badge tone={s.tone}>{s.label}</Badge>
              </div>
              {e.summary && <p className="mt-1 text-xs text-muted">{e.summary}</p>}
              {e.report && e.report.tools.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {e.report.tools.map((t) => (
                    <li key={`${t.stack}-${t.tool}`} className="text-xs">
                      <Badge tone={TOOL_TONE[t.status] ?? 'neutral'}>{t.status.replace('_', ' ')}</Badge>{' '}
                      <span className="font-medium">{t.tool}</span>
                      {t.version ? ` ${t.version}` : ''}
                      {t.detail ? <span className="text-subtle"> {t.detail}</span> : null}
                      {t.fix && <span className="block pl-1 text-muted">How to fix: {t.fix}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {e.report && e.report.logTail.length > 0 && e.state !== 'ready' && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted">Install log</summary>
                  <pre
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard reachable
                    tabIndex={0}
                    className="mt-1 max-h-60 overflow-auto rounded bg-side p-2 text-xs text-side-strong"
                  >
                    {e.report.logTail.join('\n')}
                  </pre>
                </details>
              )}
            </li>
          );
        })}
      </ul>
      {canCheck && (
        <div className="mt-3">
          <Button size="sm" loading={check.isPending} onClick={() => check.mutate()}>
            Check again
          </Button>
          <ErrorBox error={check.error} />
        </div>
      )}
    </Panel>
  );
}
