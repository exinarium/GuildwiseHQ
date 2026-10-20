import type { ReleaseQueueItem } from '@aom/shared';
import { useState } from 'react';
import { useCancelRelease, useRelease, useReleaseQueue } from '../../api/queries/delivery.ts';
import { Badge, Button, Callout, ErrorBox, Panel } from '../ui.tsx';

/**
 * The release queue (docs/design/ceo-front-door.md 14.2): releases that are READY (the recipe is approved and the gate holds),
 * with the commit, the environment and the targets. The Owner or an Admin presses Release, choosing the servers when an
 * environment has several. Nothing runs until then (unless the recipe names the CEO or says automatic).
 */
export function ReleaseQueue({ canRelease = true }: { canRelease?: boolean }) {
  const q = useReleaseQueue();
  const items = q.data ?? [];
  return (
    <Panel data-testid="release-queue">
      <h2 className="mb-1 text-lg font-semibold text-fg">Ready to release</h2>
      <p className="mb-3 text-sm text-muted">
        These releases passed their gate and wait for you. Release runs the Owner-approved recipe on the
        workstation, outside any model.
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-subtle" data-testid="release-queue-empty">
          Nothing is waiting for a release.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {items.map((i) => (
            <QueueRow key={`${i.projectId}|${i.env}|${i.commit ?? ''}`} item={i} canRelease={canRelease} />
          ))}
        </ul>
      )}
      <ErrorBox error={q.error} />
    </Panel>
  );
}

function QueueRow({ item, canRelease }: { item: ReleaseQueueItem; canRelease: boolean }) {
  const release = useRelease();
  const cancel = useCancelRelease();
  const [picked, setPicked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(item.targets.map((t) => [t.runId, item.targets.length === 1])),
  );
  const chosen = item.targets.filter((t) => picked[t.runId]);
  const several = item.targets.length > 1;
  return (
    <li className="flex flex-col gap-2 py-3" data-testid={`release-${item.projectKey}-${item.env}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold text-fg">{item.projectKey}</span>
        <Badge tone="brand">{item.env}</Badge>
        <span className="font-mono text-xs text-muted">
          {item.commit ? item.commit.slice(0, 10) : 'latest'}
        </span>
        {item.waitingFor === 'ceo' && <Badge tone="info">the recipe lets the CEO release it</Badge>}
      </div>
      {!item.gateNow.satisfied && (
        <Callout tone="warning" role="status">
          The gate does not hold any more: {item.gateNow.missing.join('; ')}. Release will refuse until it
          does.
        </Callout>
      )}
      <fieldset className="flex flex-col gap-1.5 text-sm" disabled={!canRelease}>
        <legend className="sr-only">Servers to release to</legend>
        {item.targets.map((t) => (
          <div key={t.runId} className="flex flex-wrap items-center gap-2">
            {several && (
              <input
                type="checkbox"
                checked={!!picked[t.runId]}
                aria-label={`Release to ${t.targetName}`}
                onChange={(e) => setPicked((p) => ({ ...p, [t.runId]: e.target.checked }))}
                data-testid={`pick-${t.targetName}`}
              />
            )}
            <span className="font-medium">{t.targetName}</span>
            {t.production && <Badge tone="danger">production</Badge>}
            {t.host && <span className="font-mono text-xs text-subtle">ssh {t.host}</span>}
            {t.workstationName && <span className="text-xs text-subtle">from {t.workstationName}</span>}
          </div>
        ))}
      </fieldset>
      {canRelease && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            loading={release.isPending}
            disabled={chosen.length === 0}
            data-testid={`release-${item.projectKey}-${item.env}-button`}
            onClick={() => release.mutate(chosen.map((t) => t.runId))}
          >
            {several ? `Release to ${chosen.length} of ${item.targets.length}` : 'Release'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={cancel.isPending}
            onClick={() => {
              for (const t of item.targets) cancel.mutate(t.runId);
            }}
          >
            Not now
          </Button>
        </div>
      )}
      {release.data && (
        <p className="text-xs text-muted" role="status">
          {release.data.message}
        </p>
      )}
      <ErrorBox error={release.error ?? cancel.error} />
    </li>
  );
}
