import type { CardDetailResponse } from '@aom/shared';
import { Link } from 'react-router';
import { formatDateTime } from '../lib/time.ts';
import { Badge, Panel } from './ui.tsx';

type Testing = NonNullable<CardDetailResponse['testing']>;

/** Test evidence (runs and the tester's handoff notes) plus the bug/parent links of a card. */
export function EvidencePanel({
  testing,
  handoffs,
}: {
  testing: Testing;
  handoffs: CardDetailResponse['handoffs'];
}) {
  const notes = handoffs.filter((h) => h.stage === 'test' && h.note);
  if (testing.testRuns.length === 0 && notes.length === 0) return null;
  return (
    <Panel>
      <div data-testid="evidence-panel">
        <h2 className="mb-3 text-lg font-semibold text-fg">Test evidence ({testing.testRuns.length})</h2>
        <ul className="flex flex-col gap-2">
          {testing.testRuns.map((r) => (
            <li
              key={r.id}
              data-testid="test-run"
              data-result={r.result}
              className="rounded-control border border-line p-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-subtle">
                <Badge>{r.kind.replace('_', ' ')}</Badge>
                {r.platform && <Badge tone="blue">{r.platform}</Badge>}
                <Badge tone={r.result === 'passed' ? 'green' : 'red'}>{r.result}</Badge>
                <span>{formatDateTime(r.createdAt)}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap">{r.evidence.summary}</p>
              {r.evidence.commands.length > 0 && (
                <ul className="mt-1 list-disc pl-5 font-mono text-xs">
                  {r.evidence.commands.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
              {r.evidence.outputExcerpt && (
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-sunken p-2 font-mono text-xs">
                  {r.evidence.outputExcerpt}
                </pre>
              )}
            </li>
          ))}
        </ul>
        {notes.length > 0 && (
          <div className="mt-2 border-t border-line pt-2" data-testid="test-notes">
            <h3 className="text-xs font-medium text-subtle">Test handoff notes</h3>
            {notes.map((h) => (
              <p key={h.id} className="mt-1 text-sm whitespace-pre-wrap">
                {h.note}
              </p>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

/** Status lines and links: waiting on a bug, parked on DevOps, parent and child cards. */
export function TestingLinks({
  testing,
  status,
  hideWaiting = false,
}: {
  testing: Testing;
  status: string;
  /** The card waits for a sub-workflow child (shown by its own line), not for a bug fix. */
  hideWaiting?: boolean;
}) {
  const { parent, children, waitingOn, parkedOn } = testing;
  // Only a card that waits on its open bug child (`waitingOn`) says so. A card waiting for the owner's approval, manual
  // QA, a running merge, DevOps or a sub-workflow child waits for something else, shown by its own line.
  const waits = status === 'waiting' && !hideWaiting && !!waitingOn;
  if (!parent && children.length === 0 && !waitingOn && !parkedOn) return null;
  return (
    <div className="mb-3 flex flex-col gap-1.5 text-sm" data-testid="testing-links">
      {waits && waitingOn && (
        <p data-testid="waiting-line">
          Waiting on a bug fix:{' '}
          <Link to={`/cards/${waitingOn.id}`} className="font-medium underline">
            {waitingOn.ref}
          </Link>{' '}
          {waitingOn.title}
        </p>
      )}
      {parkedOn && (
        <p
          role="status"
          data-testid="parked-notice"
          className="rounded-control border border-warning-fill/40 bg-warning-soft px-3 py-2 text-warning-soft-fg"
        >
          Tester is parked waiting on DevOps: {parkedOn.problem.replaceAll('_', ' ')}
        </p>
      )}
      {parent && (
        <p>
          Parent:{' '}
          <Link to={`/cards/${parent.ref}`} data-testid="parent-card-link" className="font-medium underline">
            {parent.ref}
          </Link>{' '}
          {parent.title}
        </p>
      )}
      {children.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {children.map((c) => (
            <li key={c.id}>
              <Link
                to={`/cards/${c.id}`}
                data-testid={`child-card-link-${c.ref}`}
                className="font-medium underline"
              >
                {c.ref}
              </Link>{' '}
              {c.title} <Badge>{c.cardType}</Badge> <Badge>{c.status}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
