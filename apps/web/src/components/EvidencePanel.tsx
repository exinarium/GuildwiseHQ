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
        <h2 className="mb-2 text-sm font-semibold">Test evidence ({testing.testRuns.length})</h2>
        <ul className="flex flex-col gap-2">
          {testing.testRuns.map((r) => (
            <li
              key={r.id}
              data-testid="test-run"
              data-result={r.result}
              className="rounded-md border border-zinc-200 p-2 text-sm dark:border-zinc-800"
            >
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
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
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-800">
                  {r.evidence.outputExcerpt}
                </pre>
              )}
            </li>
          ))}
        </ul>
        {notes.length > 0 && (
          <div className="mt-2 border-t border-zinc-200 pt-2 dark:border-zinc-800" data-testid="test-notes">
            <h3 className="text-xs font-medium text-zinc-500">Test handoff notes</h3>
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
export function TestingLinks({ testing, status }: { testing: Testing; status: string }) {
  const { parent, children, waitingOn, parkedOn } = testing;
  if (!parent && children.length === 0 && !waitingOn && !parkedOn && status !== 'waiting') return null;
  return (
    <div className="mb-3 flex flex-col gap-1.5 text-sm" data-testid="testing-links">
      {status === 'waiting' && (
        <p data-testid="waiting-line">
          Waiting on{' '}
          {waitingOn ? (
            <Link to={`/cards/${waitingOn.ref}`} className="font-medium underline">
              {waitingOn.ref}
            </Link>
          ) : (
            'a bug fix'
          )}
          {waitingOn ? ` ${waitingOn.title}` : ''}
        </p>
      )}
      {parkedOn && (
        <p
          role="status"
          data-testid="parked-notice"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
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
                to={`/cards/${c.ref}`}
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
