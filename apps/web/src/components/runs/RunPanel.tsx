import { isLiveRunState, type RunEnvironmentDto, type RunEnvState, type RunServiceState } from '@aom/shared';
import { ArrowUpFromLine, ExternalLink, RotateCw, Square, Timer } from 'lucide-react';
import { useState } from 'react';
import { useExtendRun, useRestartRun, useStopRun } from '../../api/queries/runs.ts';
import { Badge, Button, ConfirmDialog, ErrorBox, Panel, useToast } from '../ui.tsx';
import { RunLogs } from './RunLogs.tsx';

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';

export const ENV_STATE_LABEL: Record<RunEnvState, string> = {
  requested: 'Waiting for the workstation',
  preparing: 'Preparing',
  starting: 'Starting',
  healthy: 'Running',
  degraded: 'Degraded',
  stopping: 'Stopping',
  stopped: 'Stopped',
  failed: 'Failed',
};
const ENV_TONE: Record<RunEnvState, Tone> = {
  requested: 'neutral',
  preparing: 'info',
  starting: 'info',
  healthy: 'success',
  degraded: 'warning',
  stopping: 'neutral',
  stopped: 'neutral',
  failed: 'danger',
};
const SVC_TONE: Record<RunServiceState, Tone> = {
  pending: 'neutral',
  starting: 'info',
  healthy: 'success',
  unhealthy: 'warning',
  exited: 'danger',
  stopped: 'neutral',
  failed: 'danger',
};

/** "in 7 h 40 min" / "3 min ago" for the expiry line. */
export function untilText(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  const mins = Math.max(0, Math.round(Math.abs(diff) / 60_000));
  const h = Math.floor(mins / 60);
  const body = h > 0 ? `${h} h ${mins % 60} min` : `${mins} min`;
  return diff >= 0 ? `in ${body}` : `${body} ago`;
}

/** Only web links are made clickable (a URL comes from the runner, so `javascript:` and the like are never links). */
const isWebUrl = (u: string) => /^https?:\/\//i.test(u);

const short = (sha: string | null) => (sha ? sha.slice(0, 8) : 'resolving');
const clock = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

/**
 * One run environment: state, services with their links and ports, the commit of every repository, when it stops (with
 * Extend), Stop, and a live log tail. Used on the card page, the project board and the Workstations page.
 */
export function RunPanel({ env, showProject = false }: { env: RunEnvironmentDto; showProject?: boolean }) {
  const stop = useStopRun();
  const extend = useExtendRun();
  const restart = useRestartRun();
  const toast = useToast();
  const [logs, setLogs] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const live = isLiveRunState(env.state);
  const remote =
    typeof location !== 'undefined' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const ports = env.servicesStatus.flatMap((s) => s.ports.map((p) => p.port));

  return (
    <Panel
      data-testid={`run-${env.id}`}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span>
            {showProject ? `${env.projectKey} · ` : ''}
            {env.sources.map((s) => `${s.repoName}@${s.branch}`).join(', ')}
          </span>
          <Badge tone={ENV_TONE[env.state]} data-testid="run-state">
            {ENV_STATE_LABEL[env.state]}
          </Badge>
        </span>
      }
      actions={
        (live || env.canRestart) && (
          <>
            {env.canRestart && (
              <>
                <Button
                  size="sm"
                  data-testid="run-restart"
                  loading={restart.isPending}
                  title="Stop the services and start them again from the saved plan, at the same commit"
                  onClick={() =>
                    restart.mutate(
                      { id: env.id },
                      { onSuccess: () => toast.success('Restarting the environment') },
                    )
                  }
                >
                  <RotateCw aria-hidden="true" className="size-4" />
                  Restart
                </Button>
                <Button
                  size="sm"
                  data-testid="run-update-restart"
                  loading={restart.isPending}
                  title="Bring the run worktrees up to the head of their branches, then restart"
                  onClick={() =>
                    restart.mutate(
                      { id: env.id, update: true },
                      { onSuccess: () => toast.success('Updating and restarting the environment') },
                    )
                  }
                >
                  <ArrowUpFromLine aria-hidden="true" className="size-4" />
                  Update &amp; restart
                </Button>
              </>
            )}
            {live && env.canExtend && (
              <Button
                size="sm"
                data-testid="run-extend"
                loading={extend.isPending}
                onClick={() =>
                  extend.mutate({ id: env.id }, { onSuccess: () => toast.success('Environment extended') })
                }
              >
                <Timer aria-hidden="true" className="size-4" />
                Extend
              </Button>
            )}
            {live && env.canStop && (
              <Button
                size="sm"
                variant="danger-ghost"
                data-testid="run-stop"
                loading={stop.isPending}
                onClick={() => setConfirm(true)}
              >
                <Square aria-hidden="true" className="size-4" />
                Stop
              </Button>
            )}
          </>
        )
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted">
          On {env.workstationName}
          {env.requestedBy.name ? `, started by ${env.requestedBy.name}` : ''}
          {env.cardRef ? ` for ${env.cardRef}` : ''}.{' '}
          {env.activity && live && <span data-testid="run-activity">{env.activity}.</span>}
        </p>
        {env.lastError && env.state !== 'stopped' && (
          <p role="alert" className="text-danger" data-testid="run-error">
            {env.lastError}
          </p>
        )}
        {env.state === 'requested' || env.state === 'preparing' || env.state === 'starting' ? (
          env.replayed && !env.devopsRequestId ? (
            <p className="text-muted" data-testid="run-working">
              Starting from the saved run plan{env.planVersion ? ` (version ${env.planVersion})` : ''}: no
              DevOps run is needed. If it fails, the DevOps engineer of {env.workstationName} repairs the
              plan.
            </p>
          ) : (
            <p className="text-muted" data-testid="run-working">
              The DevOps engineer of {env.workstationName} is working out how to run this project. The
              services appear here as they start.
            </p>
          )
        ) : null}

        {env.servicesStatus.length > 0 && (
          <ul
            className="flex flex-col divide-y divide-line rounded-control border border-line"
            data-testid="run-services"
          >
            {env.servicesStatus.map((s) => (
              <li key={s.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="font-medium">{s.name}</span>
                <Badge tone={SVC_TONE[s.state]}>{s.state}</Badge>
                {s.restarts > 0 && <span className="text-xs text-muted">restarted {s.restarts}x</span>}
                {s.sandbox === 'docker' && (
                  <Badge
                    tone="warning"
                    data-testid="run-unsandboxed"
                    title="Docker is allowed for this project; this service is not in the sandbox"
                  >
                    Docker: outside the sandbox
                  </Badge>
                )}
                {s.sandbox === 'off' && (
                  <Badge
                    tone="warning"
                    data-testid="run-unsandboxed"
                    title="The runner could not sandbox this service (bubblewrap missing or the sandbox is off)"
                  >
                    No sandbox
                  </Badge>
                )}
                {s.ports.map((p) => (
                  <span
                    key={p.name}
                    className="tnum text-xs text-muted"
                    title={p.wanted && p.wanted !== p.port ? `port ${p.wanted} was taken` : undefined}
                  >
                    {p.name} {p.port}
                    {p.wanted && p.wanted !== p.port ? ` (was ${p.wanted})` : ''}
                  </span>
                ))}
                {live &&
                  s.state === 'healthy' &&
                  s.urls.filter(isWebUrl).map((u) => (
                    <a
                      key={u}
                      href={u}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-brand-text underline-offset-2 hover:underline"
                    >
                      {u}
                      <ExternalLink aria-hidden="true" className="size-3" />
                    </a>
                  ))}
                {s.lastError && s.state !== 'healthy' && (
                  <span className="basis-full text-xs text-danger">{s.lastError}</span>
                )}
              </li>
            ))}
          </ul>
        )}

        <ul className="text-xs text-muted" data-testid="run-commits">
          {env.sources.map((s) => (
            <li key={s.repoId}>
              {s.repoName}: <span className="font-mono">{s.branch}</span> at{' '}
              <span className="font-mono">{short(s.commit)}</span>
            </li>
          ))}
        </ul>

        {live && env.expiresAt && (
          <p className="text-xs text-muted" data-testid="run-expiry">
            Stops by itself at {clock(env.expiresAt)} ({untilText(env.expiresAt)}).
          </p>
        )}
        {!live && env.stoppedAt && (
          <p className="text-xs text-muted">
            {env.state === 'failed' ? 'Failed' : 'Stopped'} {untilText(env.stoppedAt)}
            {env.stopReason && env.stopReason !== 'stopped' ? ` (${env.stopReason})` : ''}.
          </p>
        )}
        {live && remote && ports.length > 0 && (
          <p className="text-xs text-muted" data-testid="run-ssh-hint">
            The links point at localhost on {env.workstationName}. From another machine, forward the ports:{' '}
            <code className="font-mono">
              ssh {ports.map((p) => `-L ${p}:localhost:${p}`).join(' ')} &lt;user&gt;@&lt;
              {env.workstationName}&gt;
            </code>
          </p>
        )}

        {(live || env.servicesStatus.length > 0) && (
          <div>
            <Button
              size="sm"
              variant="ghost"
              data-testid="run-logs-toggle"
              onClick={() => setLogs((v) => !v)}
            >
              {logs ? 'Hide logs' : 'Logs'}
            </Button>
            {logs && <RunLogs envId={env.id} services={env.servicesStatus.map((s) => s.name)} />}
          </div>
        )}
        <ErrorBox error={stop.error ?? extend.error ?? restart.error} />
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Stop this environment?"
        description={`The services of ${env.sources.map((s) => s.repoName).join(', ')} stop. A manual environment keeps its run worktrees for a day, so a Restart is quick; after that they are removed.`}
        confirmLabel="Stop"
        tone="danger"
        onConfirm={() => stop.mutate(env.id, { onSuccess: () => setConfirm(false) })}
        pending={stop.isPending}
      />
    </Panel>
  );
}

/** The environments of a card, project or workstation, newest first. */
export function RunList({ envs, showProject = false }: { envs: RunEnvironmentDto[]; showProject?: boolean }) {
  return (
    <div className="flex flex-col gap-3" data-testid="run-list">
      {envs.map((e) => (
        <RunPanel key={e.id} env={e} showProject={showProject} />
      ))}
    </div>
  );
}
