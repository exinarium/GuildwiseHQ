import { type BoardCard, HYGIENE_PROBLEM_LABEL, type HygieneProblemKind } from '@aom/shared';
import { Link } from 'react-router';
import { CardNotice } from './CardNotice.tsx';

const FIX = 'font-medium underline';

/** Why the card is "Blocked": the open desk item holding it, with a link to the desk. */
export function BlockedReasonNotice({ reason }: { reason: BoardCard['blockedReason'] }) {
  if (!reason) return null;
  const more = reason.others > 0 ? ` (and ${reason.others} more)` : '';
  return (
    <CardNotice
      testId="blocked-reason"
      level="danger"
      summary={`Blocked: ${reason.title}${more}`}
      detail="The card moves on when a manager answers this on the Decision desk."
      action={
        <Link to="/desk" data-testid="blocked-reason-fix" className={FIX}>
          Answer on the desk
        </Link>
      }
    />
  );
}

/** Open repository hygiene findings (a conflict, a failed login, an unconfirmed branch) on the card's repository. */
export function HygieneNotice({
  findings,
  projectId,
}: {
  findings: BoardCard['hygiene'];
  projectId: string | undefined;
}) {
  const f = findings?.[0];
  if (!findings || !f) return null;
  const label = HYGIENE_PROBLEM_LABEL[f.kind as HygieneProblemKind] ?? 'Repository problem';
  const more = findings.length > 1 ? ` (and ${findings.length - 1} more)` : '';
  return (
    <CardNotice
      testId="hygiene-warning"
      level="warning"
      summary={`${f.repoName}: ${label}${more}`}
      {...(f.detail ? { detail: f.detail } : {})}
      action={
        projectId && (
          <Link to={`/projects/${projectId}/settings#repos`} data-testid="hygiene-fix" className={FIX}>
            Open repository settings
          </Link>
        )
      }
    />
  );
}

/** The project's budget as it touches this card: paused (it will not start), nearly used up, or overridden. */
export function BudgetNotice({
  budget,
  projectId,
}: {
  budget: BoardCard['budget'];
  projectId: string | undefined;
}) {
  if (!budget) return null;
  const pct = budget.percent !== null ? ` (${Math.round(budget.percent)}% spent)` : '';
  const resets = new Date(budget.resetsAt).toLocaleDateString([], { day: 'numeric', month: 'short' });
  const summary =
    budget.state === 'paused'
      ? `Waiting: the project's monthly budget is used up${pct}`
      : budget.state === 'overridden'
        ? `The monthly budget is used up, but dispatching continues (overridden)${pct}`
        : `The monthly budget is nearly used up${pct}`;
  const detail =
    budget.state === 'paused'
      ? `Nothing new starts until the budget is raised, overridden, or resets on ${resets}.`
      : `At 100% dispatching pauses. It resets on ${resets}.`;
  return (
    <CardNotice
      testId="budget-warning"
      level={budget.state === 'paused' ? 'danger' : 'warning'}
      summary={summary}
      detail={detail}
      action={
        budget.canEdit &&
        projectId && (
          <Link to={`/projects/${projectId}/settings#budget`} data-testid="budget-fix" className={FIX}>
            Open budget settings
          </Link>
        )
      }
    />
  );
}
