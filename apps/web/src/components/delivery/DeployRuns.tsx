import type { DeployRunDto } from '@aom/shared';
import { useState } from 'react';
import { useDeployRuns } from '../../api/queries/delivery.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Panel, Select } from '../ui.tsx';

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
  queued: 'about to start',
  running: 'running',
  succeeded: 'released',
  failed: 'failed',
  refused: 'refused',
  cancelled: 'cancelled',
};

const who = (a: { kind: string; name?: string | undefined } | null): string =>
  !a ? 'nobody yet' : a.kind === 'trigger' ? 'a rule' : `${a.name ?? a.kind} (${a.kind})`;

/** History with the audit: which setup version, which rules held, who asked and who released. */
export function DeployRuns({ projectId, filters = false }: { projectId?: string; filters?: boolean }) {
  const q = useDeployRuns();
  const [open, setOpen] = useState<string | null>(null);
  const [fProject, setFProject] = useState('');
  const [fEnv, setFEnv] = useState('');
  const [fResult, setFResult] = useState('');
  const all = (q.data ?? []).filter((r) => !projectId || r.projectId === projectId);
  const runs = all.filter(
    (r) =>
      (!fProject || r.projectKey === fProject) &&
      (!fEnv || r.env === fEnv) &&
      (!fResult ||
        (fResult === 'ok'
          ? r.status === 'succeeded'
          : fResult === 'bad'
            ? ['failed', 'refused'].includes(r.status)
            : r.trigger === 'rollback')),
  );
  const projectsIn = [...new Set(all.map((r) => r.projectKey))];
  const envsIn = [...new Set(all.map((r) => r.env))];
  return (
    <Panel data-testid="deploy-runs">
      <h2 className="mb-3 text-lg font-semibold text-fg">History</h2>
      {filters && (
        <div className="mb-3 grid gap-2 sm:grid-cols-3" data-testid="history-filters">
          <Select label="Project" value={fProject} onChange={(e) => setFProject(e.target.value)}>
            <option value="">All projects</option>
            {projectsIn.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
          <Select label="Site" value={fEnv} onChange={(e) => setFEnv(e.target.value)}>
            <option value="">All sites</option>
            {envsIn.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
          <Select label="Result" value={fResult} onChange={(e) => setFResult(e.target.value)}>
            <option value="">Any result</option>
            <option value="ok">Released</option>
            <option value="bad">Failed or refused</option>
            <option value="rollback">Went back to an earlier version</option>
          </Select>
        </div>
      )}
      {runs.length === 0 && (
        <p className="text-sm text-subtle" data-testid="history-empty">
          Nothing has been released yet.
        </p>
      )}
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
              {r.trigger === 'rollback' && <Badge tone="amber">Rollback</Badge>}
              {r.trial && <Badge>{r.dryRun ? 'tried without changes' : 'trial'}</Badge>}
              <span className="font-mono text-xs text-subtle">{r.commit?.slice(0, 10) ?? ''}</span>
              <span className="ml-auto text-xs text-subtle">{formatDateTime(r.createdAt)}</span>
            </button>
            {open === r.id && (
              <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-muted sm:grid-cols-[10rem_1fr]">
                <dt>Asked by</dt>
                <dd>{who(r.requestedBy)}</dd>
                <dt>Released by</dt>
                <dd>{who(r.releasedBy)}</dd>
                <dt>Setup version</dt>
                <dd className="font-mono">{r.recipeHash.slice(0, 16)}</dd>
                {r.evidence.length > 0 && (
                  <>
                    <dt>Rules that held</dt>
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
