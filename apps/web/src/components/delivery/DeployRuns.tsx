import type { DeployRunDto } from '@aom/shared';
import { useState } from 'react';
import { useDeployRuns } from '../../api/queries/delivery.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Panel } from '../ui.tsx';

const TONE: Record<DeployRunDto['status'], 'neutral' | 'green' | 'red' | 'amber' | 'blue'> = {
  requested: 'neutral',
  waiting_release: 'amber',
  queued: 'blue',
  running: 'blue',
  succeeded: 'green',
  failed: 'red',
  refused: 'red',
  cancelled: 'neutral',
};
const LABEL: Record<DeployRunDto['status'], string> = {
  requested: 'requested',
  waiting_release: 'waiting for a release',
  queued: 'sent to the workstation',
  running: 'running',
  succeeded: 'deployed',
  failed: 'failed',
  refused: 'refused',
  cancelled: 'cancelled',
};

const who = (a: { kind: string; name?: string | undefined } | null): string =>
  !a ? 'nobody yet' : a.kind === 'trigger' ? 'a rule' : `${a.name ?? a.kind} (${a.kind})`;

/** Recent deploys with the audit: which recipe version, which gate and evidence, released by whom. */
export function DeployRuns({ projectId }: { projectId?: string }) {
  const q = useDeployRuns();
  const [open, setOpen] = useState<string | null>(null);
  const runs = (q.data ?? []).filter((r) => !projectId || r.projectId === projectId);
  return (
    <Panel data-testid="deploy-runs">
      <h2 className="mb-3 text-lg font-semibold text-fg">Recent deploys</h2>
      {runs.length === 0 && <p className="text-sm text-subtle">No deploy has been asked for yet.</p>}
      <ul className="flex flex-col divide-y divide-line text-sm">
        {runs.map((r) => (
          <li key={r.id} className="py-2" data-testid={`run-${r.id}`}>
            <button
              type="button"
              className="flex w-full flex-wrap items-center gap-2 text-left"
              aria-expanded={open === r.id}
              onClick={() => setOpen(open === r.id ? null : r.id)}
            >
              <span className="font-medium text-fg">{r.projectKey}</span>
              <Badge tone="brand">{r.env}</Badge>
              <span className="text-muted">{r.targetName}</span>
              <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>
              {r.trial && <Badge>{r.dryRun ? 'dry run' : 'trial'}</Badge>}
              <span className="font-mono text-xs text-subtle">{r.commit?.slice(0, 10) ?? ''}</span>
              <span className="ml-auto text-xs text-subtle">{formatDateTime(r.createdAt)}</span>
            </button>
            {open === r.id && (
              <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-muted sm:grid-cols-[10rem_1fr]">
                <dt>Asked by</dt>
                <dd>{who(r.requestedBy)}</dd>
                <dt>Released by</dt>
                <dd>{who(r.releasedBy)}</dd>
                <dt>Recipe version</dt>
                <dd className="font-mono">{r.recipeHash.slice(0, 16)}</dd>
                {r.evidence.length > 0 && (
                  <>
                    <dt>Gate evidence</dt>
                    <dd>
                      <ul>
                        {r.evidence.map((e) => (
                          <li key={`${e.requirement}-${e.ref}`}>
                            {e.requirement}: {e.detail}
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
                {(r.refusal || r.missing.length > 0) && (
                  <>
                    <dt>Why not</dt>
                    <dd>
                      {r.refusalDetail ?? r.refusal}
                      {r.missing.length > 0 ? ` (${r.missing.join('; ')})` : ''}
                    </dd>
                  </>
                )}
                {r.summary && (
                  <>
                    <dt>Result</dt>
                    <dd>
                      {r.summary}
                      {r.url ? `, ${r.url}` : ''}
                    </dd>
                  </>
                )}
                {r.logTail && (
                  <>
                    <dt>Log (end)</dt>
                    <dd>
                      <pre className="max-h-48 overflow-auto rounded-control bg-sunken p-2 whitespace-pre-wrap">
                        {r.logTail}
                      </pre>
                    </dd>
                  </>
                )}
              </dl>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
