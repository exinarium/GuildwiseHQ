import type { CeoStatusDto } from '@aom/shared';
import { useState } from 'react';
import { useCeoTraining } from '../../api/queries/ceo.ts';
import { agreementText, classLabel } from '../../lib/ceo.ts';
import { formatDate } from '../../lib/time.ts';
import { Button, Callout, ConfirmDialog, ErrorBox, Panel } from '../ui.tsx';

export function ScoreList({ status }: { status: Pick<CeoStatusDto, 'scores' | 'totals'> }) {
  if (status.totals.total === 0)
    return (
      <p className="text-sm text-muted" data-testid="ceo-scores-empty">
        No recommendations answered yet.
      </p>
    );
  return (
    <div data-testid="ceo-scores">
      <p className="text-base font-medium text-fg" data-testid="ceo-score-total">
        You {agreementText(status.totals.agreed, status.totals.total)}.
      </p>
      <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {status.scores.map((s) => (
          <li key={s.class} className="flex justify-between gap-3" data-testid="ceo-score-row">
            <span className="text-muted">{classLabel(s.class)}</span>
            <span className="tnum text-fg">
              {s.agreed} of {s.total}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The training period (owner decision): the CEO recommends, you decide, and the difference teaches it. */
export function TrainingBlock({ status, owner }: { status: CeoStatusDto; owner: boolean }) {
  const training = useCeoTraining();
  const [confirm, setConfirm] = useState(false);
  const t = status.training;

  if (t.on)
    return (
      <Panel title="Training period" data-testid="ceo-training">
        <div className="flex flex-col gap-3">
          <p className="text-base font-medium text-fg" data-testid="ceo-training-left">
            {t.daysLeft > 0
              ? `Training period: ${t.daysLeft} day${t.daysLeft === 1 ? '' : 's'} left`
              : 'Training period: the planned time is over. You can end it any time.'}
          </p>
          <p className="text-sm text-muted">
            During training, staffing and model changes (hire, bench, retire, promote or demote, model change,
            scale) are only recommendations. Your answers on the desk teach the CEO what you would have done.
          </p>
          <ScoreList status={status} />
          {owner && (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => setConfirm(true)} data-testid="ceo-graduate">
                Graduate
              </Button>
              <Button
                loading={training.isPending && training.variables === 'extend'}
                onClick={() => training.mutate('extend')}
                data-testid="ceo-extend"
              >
                Extend by 7 days
              </Button>
            </div>
          )}
          <ErrorBox error={training.error} />
        </div>
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title="Graduate the CEO?"
          confirmLabel="Graduate"
          tone="primary"
          pending={training.isPending}
          onConfirm={() => training.mutate('graduate', { onSuccess: () => setConfirm(false) })}
        >
          <div className="flex flex-col gap-3" data-testid="ceo-graduate-dialog">
            <ScoreList status={status} />
            <p className="text-sm text-muted">
              Graduating unlocks the policy table as you configured it. With the defaults the CEO decides
              within the limits on hiring, benching, model changes and the other staffing matters; firing, and
              the owner-reserved matters, stay with you. You can change anything on the Authority tab, and
              restart training later.
            </p>
          </div>
        </ConfirmDialog>
      </Panel>
    );

  return (
    <Panel title="Training" data-testid="ceo-training">
      <div className="flex flex-col gap-3">
        <p className="text-base font-medium text-fg" data-testid="ceo-graduated">
          {t.graduatedAt ? `Graduated on ${formatDate(t.graduatedAt)}` : 'Training is over'}
        </p>
        <ScoreList status={status} />
        {owner && (
          <div>
            <Button
              loading={training.isPending}
              onClick={() => training.mutate('restart')}
              data-testid="ceo-restart-training"
            >
              Restart training
            </Button>
          </div>
        )}
        <ErrorBox error={training.error} />
        {!owner && <Callout tone="info">Only the Owner can restart training.</Callout>}
      </div>
    </Panel>
  );
}
