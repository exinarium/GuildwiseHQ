import { useState } from 'react';
import {
  type PlatformTeamOverview,
  useCreatePlatformPause,
  useResumePlatformPause,
  useSetRunnerPin,
} from '../../api/queries/platformTeam.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Button, ErrorBox, Panel } from '../ui.tsx';

const sevTone = { critical: 'danger', degraded: 'warning', minor: 'neutral', unrated: 'info' } as const;

/** The platform team's lists: open pauses (with resume), bugs, grants, safe-mode pins and the deploy audit trail. */
export function PlatformTeamPanels({ data }: { data: PlatformTeamOverview }) {
  const resume = useResumePlatformPause();
  const pause = useCreatePlatformPause();
  const pin = useSetRunnerPin();
  const [pauseProject, setPauseProject] = useState('');
  const [pauseReason, setPauseReason] = useState('');
  const [pinVersion, setPinVersion] = useState('');
  const open = data.pauses.filter((p) => !p.resumedAt);
  return (
    <div className="flex flex-col gap-4" data-testid="platform-team-panels">
      <Panel title={`Pauses (${open.length} open)`}>
        {data.pauses.length === 0 && <p className="text-sm text-muted">Nothing is paused.</p>}
        <ul className="divide-y divide-border text-sm" data-testid="platform-pauses">
          {data.pauses.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
              <Badge tone={p.resumedAt ? 'neutral' : 'warning'}>{p.resumedAt ? 'Resumed' : 'Paused'}</Badge>
              <span className="font-medium">
                {[
                  p.projectKey && `project ${p.projectKey}`,
                  p.workflowKey && `workflow ${p.workflowKey}`,
                  p.stageId && `stage ${p.stageId}`,
                  p.workstationName && `workstation ${p.workstationName}`,
                ]
                  .filter(Boolean)
                  .join(', ')}
              </span>
              <span className="text-muted">
                {p.source === 'auto' ? 'automatic' : 'manual'}: {p.reason}
                {p.bugCardRef && ` (${p.bugCardRef})`}
              </span>
              <span className="ml-auto text-xs text-subtle">{formatDateTime(p.createdAt)}</span>
              {!p.resumedAt && data.canManage && (
                <Button size="sm" loading={resume.isPending} onClick={() => resume.mutate(p.id)}>
                  Resume
                </Button>
              )}
            </li>
          ))}
        </ul>
        {data.canManage && (
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              pause.mutate(
                { projectId: pauseProject.trim() || null, reason: pauseReason.trim() },
                {
                  onSuccess: () => {
                    setPauseProject('');
                    setPauseReason('');
                  },
                },
              );
            }}
          >
            <label className="text-xs text-muted">
              Project id
              <input
                className="mt-1 block w-72 rounded-control border border-border bg-surface px-2 py-1 text-sm"
                value={pauseProject}
                onChange={(e) => setPauseProject(e.target.value)}
                placeholder="project uuid"
              />
            </label>
            <label className="text-xs text-muted">
              Reason
              <input
                className="mt-1 block w-72 rounded-control border border-border bg-surface px-2 py-1 text-sm"
                value={pauseReason}
                onChange={(e) => setPauseReason(e.target.value)}
              />
            </label>
            <Button type="submit" disabled={!pauseProject.trim() || pauseReason.trim().length < 3}>
              Pause project
            </Button>
          </form>
        )}
        <ErrorBox error={resume.error ?? pause.error} />
      </Panel>

      <Panel title="Bugs">
        {data.bugs.length === 0 && <p className="text-sm text-muted">No bugs reported yet.</p>}
        <ul className="divide-y divide-border text-sm" data-testid="platform-bugs">
          {data.bugs.map((b) => (
            <li key={b.signature} className="flex flex-wrap items-center gap-2 py-2">
              <Badge tone={sevTone[b.severity]}>{b.severity}</Badge>
              {b.status !== 'open' && <Badge tone="neutral">{b.status}</Badge>}
              <span className="font-medium">{b.title}</span>
              <span className="text-muted">
                {b.cardRef ?? 'not filed yet'} · {b.source.replace('_', ' ')} · seen {b.occurrences}×
              </span>
              <span className="ml-auto text-xs text-subtle">{formatDateTime(b.lastSeenAt)}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Safe mode: runner version pins">
        {data.pins.length === 0 && <p className="text-sm text-muted">No workstation is pinned.</p>}
        <ul className="text-sm" data-testid="platform-pins">
          {data.pins.map((p) => (
            <li key={p.workstationId ?? 'all'} className="flex flex-wrap items-center gap-2 py-1">
              <Badge tone="warning">{p.version}</Badge>
              <span>{p.workstationId ? `workstation ${p.workstationId}` : 'all workstations'}</span>
              {p.reason && <span className="text-muted">{p.reason}</span>}
              {data.canManage && (
                <Button
                  size="sm"
                  onClick={() => pin.mutate({ workstationId: p.workstationId, version: null })}
                  loading={pin.isPending}
                >
                  Unpin
                </Button>
              )}
            </li>
          ))}
        </ul>
        {data.canManage && (
          <form
            className="mt-2 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              pin.mutate({ workstationId: null, version: pinVersion.trim(), reason: 'safe mode' });
            }}
          >
            <label className="text-xs text-muted">
              Pin all workstations to version
              <input
                className="mt-1 block w-40 rounded-control border border-border bg-surface px-2 py-1 text-sm"
                value={pinVersion}
                onChange={(e) => setPinVersion(e.target.value)}
                placeholder="0.1.24"
              />
            </label>
            <Button type="submit" disabled={!/^\d+\.\d+\.\d+/.test(pinVersion.trim())}>
              Pin
            </Button>
          </form>
        )}
        <ErrorBox error={pin.error} />
      </Panel>

      <Panel title="Diagnostics grants">
        {data.grants.length === 0 && <p className="text-sm text-muted">No grants requested.</p>}
        <ul className="text-sm" data-testid="platform-grants">
          {data.grants.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-2 py-1">
              <Badge tone={g.status === 'approved' ? 'success' : 'neutral'}>{g.status}</Badge>
              <span>{g.clientOrgName ?? 'a client organization'}</span>
              <span className="text-muted">
                {g.reason}
                {g.expiresAt && g.status === 'approved' ? ` · until ${formatDateTime(g.expiresAt)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Deploy audit trail">
        {data.audit.length === 0 && <p className="text-sm text-muted">No deploys recorded.</p>}
        <ul className="divide-y divide-border text-sm" data-testid="platform-audit">
          {data.audit.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 py-1">
              <Badge tone={a.risk === 'high' ? 'danger' : 'neutral'}>{a.kind}</Badge>
              <span className="font-medium">{a.version}</span>
              <span className="text-muted">
                {a.risk} risk
                {a.downtime ? ', downtime' : ''}
                {a.outcome
                  ? `, ${a.outcome}`
                  : a.allowed === null
                    ? ''
                    : a.allowed
                      ? ', allowed'
                      : ', not allowed'}
                {a.approvedBy ? `, approved by ${a.approvedBy}` : ''}
              </span>
              <span className="ml-auto text-xs text-subtle">{formatDateTime(a.at)}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
