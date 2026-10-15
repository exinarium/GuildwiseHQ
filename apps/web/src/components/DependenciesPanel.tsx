import type { CardDto } from '@aom/shared';
import { Badge, Panel } from './ui.tsx';

type Dependency = CardDto['dependencies'][number];

const QA_STAGES = new Set(['qa_steps', 'manual_qa']);

/** What a dependency's state means for this card: waiting for it, or its work is in the working branch. */
export function dependencyLine(d: Dependency): { text: string; landed: boolean } {
  if (d.status === 'cancelled') return { text: `${d.ref} cancelled`, landed: true };
  if (d.status === 'done') return { text: `${d.ref} landed`, landed: true };
  if (d.landed) {
    const where = d.stage && QA_STAGES.has(d.stage) ? 'in manual QA' : 'finalized, still open';
    return { text: `${d.ref} landed (${where})`, landed: true };
  }
  return { text: `waiting for ${d.ref} to land`, landed: false };
}

/**
 * Dependencies on the card page (backlog #80): a dependency has landed once its work is in the working branch, even
 * while it waits in Manual QA. Also the design review: a design made before the dependencies landed records its
 * assumptions, which the architect reviews once they have.
 */
export function DependenciesPanel({ card }: { card: CardDto }) {
  const review = card.designReview;
  if (card.dependencies.length === 0 && !review) return null;
  const refs = review?.dependencies.join(', ') ?? '';
  return (
    <Panel title="Depends on" data-testid="dependencies-panel">
      {card.dependencies.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {card.dependencies.map((d) => {
            const line = dependencyLine(d);
            return (
              <li key={d.cardId} data-testid="dependency-line" className="flex flex-wrap items-center gap-2">
                <Badge tone={line.landed ? 'green' : 'amber'}>{line.landed ? 'Landed' : 'Waiting'}</Badge>
                <span>{line.text}</span>
                <span className="text-muted">{d.title}</span>
              </li>
            );
          })}
        </ul>
      )}
      {review && (
        <div data-testid="design-review" className="mt-3 text-sm">
          {review.state === 'reviewed' ? (
            <p>
              Assumptions reviewed: {review.result?.confirmed ?? 0} confirmed, {review.result?.revised ?? 0}{' '}
              revised.
              {review.result?.note ? ` ${review.result.note}` : ''}
            </p>
          ) : (
            <p>
              Design made before {refs} landed: assumptions to review
              {review.state === 'review_due'
                ? '. The dependencies have landed; the architect reviews them next, before Build.'
                : ', once they have landed. Build waits for both.'}
            </p>
          )}
          {review.assumptions.length > 0 && (
            <ol className="mt-1 list-decimal pl-5 text-muted">
              {review.assumptions.map((a) => (
                <li key={`${a.dependency}-${a.assumption}`}>
                  {a.assumption} ({a.dependency}); if wrong: {a.ifWrong}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </Panel>
  );
}
