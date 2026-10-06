import { type DeskItemDto, type FloorDigest, SIGNAL_LABEL } from '@aom/shared';
import { Link } from 'react-router';
import { Badge } from './ui.tsx';

/** Part B: the BA's context on an item, how the routing handled it, and the link to the standing BA chat. */
export function BaNote({ item }: { item: DeskItemDto }) {
  const triage = item.triage ?? 'none';
  return (
    <>
      {triage === 'passed' && (
        <p className="mt-1 text-xs text-subtle" data-testid="triage-passed">
          Your BA looked at this first and passed it on.
        </p>
      )}
      {triage === 'released' && (
        <p className="mt-1 text-xs text-subtle" data-testid="triage-released">
          Your BA had not looked at this in time, so it reached you unchanged.
        </p>
      )}
      {item.baNote && (
        <div
          role="note"
          data-testid="ba-note"
          className="mt-2 rounded-control border border-brand/30 bg-brand-soft p-2 text-sm"
        >
          <p className="text-xs font-medium text-brand-soft-fg">BA note</p>
          <p className="mt-0.5 whitespace-pre-wrap">{item.baNote}</p>
        </div>
      )}
      {item.chatThreadId && (
        <p className="mt-2 text-xs">
          <Link to={`/chat/${item.chatThreadId}`} className="underline" data-testid="ba-chat-link">
            Discuss this with your BA
          </Link>
        </p>
      )}
    </>
  );
}

const Section = ({ title, children, count }: { title: string; children: React.ReactNode; count: number }) => (
  <section className="mt-2">
    <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
      {title} <span className="font-normal normal-case">({count})</span>
    </h3>
    {count === 0 ? (
      <p className="text-sm text-subtle">None.</p>
    ) : (
      <ul className="list-disc pl-5 text-sm">{children}</ul>
    )}
  </section>
);

/** The structured facts behind a daily floor report: the six sections of owner decision B6. */
export function FloorReport({ digest }: { digest: FloorDigest }) {
  const stuck = digest.signals.filter((s) => ['blocked', 'unclaimed', 'loop'].includes(s.kind));
  const approvals = digest.signals.filter((s) => s.kind === 'repeated_approval');
  const failed = digest.signals.filter((s) =>
    ['rework', 'finalize_failures', 'repo_hygiene'].includes(s.kind),
  );
  return (
    <div data-testid="floor-report" className="mt-2 border-t border-line pt-1">
      <Section title="Phases waiting or open" count={digest.phases.length}>
        {digest.phases.map((p) => (
          <li key={p.ref}>
            {p.ref} {p.name}: {p.status}
            {p.lateBugs.length > 0 && (
              <Badge tone="amber" title="Open bugs filed after the phase's work finished">
                held open by late bugs {p.lateBugs.join(', ')}
              </Badge>
            )}
          </li>
        ))}
      </Section>
      <Section title="Stuck, blocked and backing-off cards" count={stuck.length + digest.backingOff.length}>
        {stuck.map((s) => (
          <li key={s.id}>
            {s.subject.title}
            {s.subject.detail ? ` (${s.subject.detail})` : ''}
          </li>
        ))}
        {digest.backingOff.map((b) => (
          <li key={b.ref}>
            {b.ref} {b.title}: backing off after {b.failures} failed shifts
          </li>
        ))}
      </Section>
      <Section title="Repeated approvals" count={approvals.length}>
        {approvals.map((s) => (
          <li key={s.id}>
            {s.subject.title} ({s.count} times)
          </li>
        ))}
      </Section>
      <Section title="Failures" count={failed.length + digest.failures.length}>
        {failed.map((s) => (
          <li key={s.id}>
            {SIGNAL_LABEL[s.kind]}: {s.subject.title}
          </li>
        ))}
        {digest.failures.map((f) => (
          <li key={f.ref}>
            {f.ref} {f.title}: {f.failedShifts} failed shifts
          </li>
        ))}
      </Section>
      <Section title="DevOps requests that are open" count={digest.devopsOpen.length}>
        {digest.devopsOpen.map((r) => (
          <li key={r.id}>
            {r.summary} on {r.workstation}: {r.status}
          </li>
        ))}
      </Section>
      <Section title="Resolved by the BA without bothering you" count={digest.resolvedByBa.length}>
        {digest.resolvedByBa.map((r) => (
          <li key={r.id}>
            {r.title} ({r.how}
            {r.note ? `: ${r.note}` : ''})
          </li>
        ))}
      </Section>
    </div>
  );
}
