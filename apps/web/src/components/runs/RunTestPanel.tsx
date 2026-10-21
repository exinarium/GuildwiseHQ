import { isLiveRunState, type RunPlan, type RunWorkstationDto, type TestRan } from '@aom/shared';
import { Play, Square } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { useTestRunPlan } from '../../api/queries/run-plan.ts';
import { useRun, useStopRun } from '../../api/queries/runs.ts';
import { Button, Callout, ErrorBox, Select, Spinner } from '../ui.tsx';

const isWebUrl = (u: string) => /^https?:\/\//i.test(u);

/**
 * "Test these steps": starts the app once on a computer of the project from the given steps (saved or not) and says in plain
 * words whether it worked (docs/design/deploy-run-ux-design.md section 3.1). The environment is an ordinary manual run, so
 * it also shows on the Workstations page and stops by itself.
 */
export function RunTestPanel({
  projectId,
  plan,
  workstations,
  label = 'Test these steps',
  disabledReason,
}: {
  projectId: string;
  /** The steps to test; absent: the saved ones. */
  plan?: RunPlan;
  workstations: RunWorkstationDto[];
  label?: string;
  disabledReason?: string | undefined;
}) {
  const test = useTestRunPlan(projectId);
  const stop = useStopRun();
  const usable = workstations.filter((w) => w.canRun);
  const [wsId, setWsId] = useState('');
  const [envId, setEnvId] = useState<string | undefined>();
  const [ran, setRan] = useState<TestRan | null>(null);
  const env = useRun(envId);
  const chosen = wsId || (usable.find((w) => w.connected) ?? usable[0])?.id || '';
  const ws = workstations.find((w) => w.id === chosen);
  const e = env.data;

  const run = () => {
    if (!chosen) return;
    test.mutate(
      { workstationId: chosen, ...(plan ? { plan } : {}) },
      {
        onSuccess: (r) => {
          setEnvId(r.environment.id);
          setRan(r.ran ?? null);
        },
      },
    );
  };
  const busy = test.isPending || (!!e && isLiveRunState(e.state) && e.state !== 'healthy');

  return (
    <div className="flex flex-col gap-3" data-testid="run-test">
      <div className="flex flex-wrap items-end gap-3">
        {usable.length > 1 && (
          <div className="min-w-48 flex-1">
            <Select label="Test on" value={chosen} onChange={(ev) => setWsId(ev.target.value)}>
              {usable.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.connected ? '' : ' (offline)'}
                </option>
              ))}
            </Select>
          </div>
        )}
        <Button
          onClick={run}
          loading={busy}
          disabled={!chosen || !ws?.connected || !!disabledReason}
          data-testid="run-test-button"
        >
          <Play aria-hidden="true" className="size-4" />
          {label}
        </Button>
      </div>
      {usable.length === 0 && (
        <p className="text-xs text-subtle">
          No computer of yours can start the app: it needs Guildwise running on a computer that has the
          project's code.
        </p>
      )}
      {ws && !ws.connected && <p className="text-xs text-subtle">{ws.name} is offline.</p>}
      {disabledReason && <p className="text-xs text-subtle">{disabledReason}</p>}
      {test.error instanceof ApiError && test.error.code === 'already_running' ? (
        <Callout
          tone="warning"
          title="A test copy is already running there"
          data-testid="run-test-running"
          actions={
            <Button
              size="sm"
              loading={stop.isPending}
              onClick={() => {
                const id = (test.error as ApiError).details as { envId?: string } | undefined;
                if (id?.envId) stop.mutate(id.envId, { onSuccess: () => test.reset() });
              }}
            >
              <Square aria-hidden="true" className="size-4" />
              Stop the running copy
            </Button>
          }
        >
          Stop the running copy first, then test again.
        </Callout>
      ) : (
        <ErrorBox error={test.error} />
      )}
      {ran && e && (
        <p className="text-xs text-subtle" data-testid="run-test-ran">
          Tested:{' '}
          {ran.source === 'unsaved'
            ? 'the steps on this screen (not saved yet)'
            : ran.source === 'project'
              ? `the project steps, version ${ran.version}`
              : `this computer's own steps, version ${ran.version}`}
          .
        </p>
      )}
      {e && (e.state === 'requested' || e.state === 'preparing' || e.state === 'starting') && (
        <div
          className="flex items-center gap-2 text-sm text-muted"
          role="status"
          data-testid="run-test-starting"
        >
          <Spinner inline label="Starting" />
          Starting the app on {e.workstationName}
          {e.activity ? `: ${e.activity}` : ''}. This can take a few minutes.
        </div>
      )}
      {e && (e.state === 'healthy' || e.state === 'degraded') && (
        <Callout
          tone="success"
          title="Started"
          data-testid="run-test-ok"
          actions={
            e.canStop ? (
              <Button size="sm" onClick={() => stop.mutate(e.id)} loading={stop.isPending}>
                <Square aria-hidden="true" className="size-4" />
                Stop it
              </Button>
            ) : undefined
          }
        >
          {(() => {
            const urls = e.servicesStatus.flatMap((s) => s.urls).filter(isWebUrl);
            return urls.length ? (
              <span>
                Open it:{' '}
                {urls.map((u, i) => (
                  <span key={u}>
                    {i > 0 && ', '}
                    <a href={u} target="_blank" rel="noreferrer noopener">
                      {u}
                    </a>
                  </span>
                ))}
                . It stops by itself later.
              </span>
            ) : (
              'The steps worked. It stops by itself later.'
            );
          })()}
        </Callout>
      )}
      {e && e.state === 'failed' && (
        <Callout tone="danger" title="The app did not start" data-testid="run-test-failed">
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {(e.failureReason ?? e.lastError ?? 'Something went wrong while starting.').slice(0, 800)}
          </p>
          <p className="text-xs">Change the steps and test again, or ask DevOps to scan the project.</p>
        </Callout>
      )}
      {e && e.state === 'stopped' && <p className="text-sm text-muted">The test copy has stopped.</p>}
    </div>
  );
}
