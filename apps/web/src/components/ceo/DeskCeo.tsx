import type { DeskItemDto } from '@aom/shared';
import { Bot } from 'lucide-react';
import { useCeoStatus } from '../../api/queries/ceo.ts';
import { agreementText, classLabel, MODE_LABEL, pct } from '../../lib/ceo.ts';
import { useActiveOrgRole } from '../../lib/orgRole.ts';
import { Badge, Button, Callout } from '../ui.tsx';
import { CorrectButton } from './CorrectDialog.tsx';
import { RepeatsSection } from './RepeatsSection.tsx';
import { TopicsReportSection } from './TopicReview.tsx';
import { UndoButton } from './UndoButton.tsx';

export const ceoName = (item: Pick<DeskItemDto, 'ceo'>): string => item.ceo?.agentName ?? 'The CEO';

/** "Answered by <name>: <reason> (confidence NN%)" with an Undo for the Owner while it can still be undone. */
export function CeoAnswered({ item }: { item: DeskItemDto }) {
  // Hooks only run for items the CEO handled: every other item costs nothing.
  return item.ceo?.actionId ? <CeoAnsweredBody item={item} actionId={item.ceo.actionId} /> : null;
}

function CeoAnsweredBody({ item, actionId }: { item: DeskItemDto; actionId: string }) {
  const owner = useActiveOrgRole() === 'owner';
  const c = item.ceo;
  if (!c) return null;
  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-brand/25 bg-brand-soft p-3 text-sm text-brand-soft-fg"
      data-testid="ceo-answered"
    >
      <Bot aria-hidden="true" className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        Answered by {ceoName(item)}
        {c.reason ? `: ${c.reason}` : ''}
        {c.confidence !== null && ` (confidence ${pct(c.confidence)})`}
      </p>
      {c.undoable && owner && (
        <UndoButton actionId={actionId} what="The answer is withdrawn and the item reopens" />
      )}
    </div>
  );
}

/** "<name> recommends: <option>" with the reason; the answer form preselects the option. */
export function CeoRecommendation({
  item,
  onAccept,
  accepting,
}: {
  item: DeskItemDto;
  /** Answer with the recommendation (question and escalation items). */
  onAccept?: (() => void) | undefined;
  accepting?: boolean;
}) {
  const r = item.ceo?.recommendation;
  if (!r) return null;
  const option = item.options.find((o) => o.id === r.option)?.label;
  return (
    <div
      className="mt-3 rounded-control border border-brand/25 bg-brand-soft p-3 text-sm text-brand-soft-fg"
      role="note"
      data-testid="ceo-recommendation"
    >
      <p className="flex items-center gap-1.5 font-semibold">
        <Bot aria-hidden="true" className="size-4 shrink-0" />
        {ceoName(item)} recommends: {option ?? r.text ?? 'see the reason'}
      </p>
      <p className="mt-1">{r.reason}</p>
      <p className="mt-0.5 text-xs">Confidence {pct(r.confidence)}</p>
      {onAccept && (
        <div className="mt-2">
          <Button
            size="sm"
            variant="primary"
            loading={accepting ?? false}
            onClick={onAccept}
            data-testid="ceo-accept"
          >
            Accept recommendation
          </Button>
        </div>
      )}
    </div>
  );
}

/** The daily report: what the CEO did in the last 24 hours (Undo for the Owner) and the training scores. */
export function CeoReportBlock({ item }: { item: DeskItemDto }) {
  return item.ceoReport ? <CeoReportBody report={item.ceoReport} /> : null;
}

function CeoReportBody({ report: r }: { report: NonNullable<DeskItemDto['ceoReport']> }) {
  const owner = useActiveOrgRole() === 'owner';
  const totals = r.scores.reduce((a, s) => ({ agreed: a.agreed + s.agreed, total: a.total + s.total }), {
    agreed: 0,
    total: 0,
  });
  return (
    <div className="mt-3 flex flex-col gap-3" data-testid="ceo-report">
      {r.fallback && (
        <Callout tone="info" role="note">
          The CEO could not write this report itself, so this is the plain summary.
        </Callout>
      )}
      {r.scores.length > 0 && (
        <div data-testid="ceo-report-scores">
          <h3 className="text-sm font-semibold text-fg">Training</h3>
          <p className="text-sm text-muted">You {agreementText(totals.agreed, totals.total)}.</p>
          <ul className="mt-1 text-sm text-muted">
            {r.scores.map((s) => (
              <li key={s.class}>
                {classLabel(s.class)}: {s.agreed} of {s.total}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="text-sm font-semibold text-fg">The last 24 hours ({r.actions.length})</h3>
        {r.actions.length === 0 ? (
          <p className="text-sm text-subtle">Nothing.</p>
        ) : (
          <ul className="mt-1 divide-y divide-line">
            {r.actions.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm"
                data-testid="ceo-report-action"
              >
                <span className="min-w-0 text-fg">
                  {classLabel(a.class)}: {a.subject}{' '}
                  <Badge tone={a.mode === 'decided' ? 'green' : a.mode === 'refused' ? 'red' : 'blue'}>
                    {MODE_LABEL[a.mode as keyof typeof MODE_LABEL] ?? a.mode}
                  </Badge>
                  {a.status === 'undone' && (
                    <Badge className="ml-1" tone="amber">
                      Undone
                    </Badge>
                  )}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {a.undoable && owner && a.status !== 'undone' && (
                    <UndoButton actionId={a.id} what={a.subject} />
                  )}
                  {a.mode === 'decided' && a.correctable !== false && (
                    <CorrectButton
                      testId={`report-correct-${a.id}`}
                      target={{
                        actionId: a.id,
                        label: `${classLabel(a.class)}: ${a.subject}`,
                        ...(a.undoable && owner && a.status !== 'undone' ? { undoLabel: '' } : {}),
                      }}
                    />
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {r.orderTurns && r.orderTurns.length > 0 && (
        <div data-testid="ceo-report-order-turns">
          <h3 className="text-sm font-semibold text-fg">Standing order turns</h3>
          <ul className="mt-1 divide-y divide-line">
            {r.orderTurns.map((t) => (
              <li key={t.turnId} className="flex flex-wrap items-start justify-between gap-2 py-1.5 text-sm">
                <span className="min-w-0 text-fg">
                  {t.orderTitle}: {t.summary || t.ask || t.outcome}
                  {t.commands.length > 0 && (
                    <span className="block text-xs text-subtle">{t.commands.length} commands run</span>
                  )}
                </span>
                {t.corrected ? (
                  <span className="text-xs text-muted">Corrected</span>
                ) : (
                  owner && (
                    <CorrectButton
                      label="I'd rather you didn't"
                      testId={`report-correct-order-${t.turnId}`}
                      target={{ orderTurnId: t.turnId, label: `Standing order: ${t.orderTitle}` }}
                    />
                  )
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.repeats && <RepeatsSection repeats={r.repeats} owner={owner} />}
      <TopicsReportSection />
    </div>
  );
}

/** Owner only, and only while the organization has (had) a CEO: keep this answer as an owner rule. */
export function RememberCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const owner = useActiveOrgRole() === 'owner';
  const status = useCeoStatus(owner);
  if (!owner || status.data?.hired === false) return null;
  return (
    <label className="flex items-center gap-2 text-sm text-fg">
      <input
        type="checkbox"
        className="size-4"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid="ceo-remember"
      />
      Remember this for the CEO
    </label>
  );
}
