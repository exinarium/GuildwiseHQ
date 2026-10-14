import type { CardQa } from '@aom/shared';
import { useEffect, useMemo, useState } from 'react';
import { useQaAssign, useQaPass, useQaSendBack, useQaSkip } from '../api/queries/qa.ts';
import { countSteps, parseQaSteps } from '../lib/qaSteps.ts';
import { formatDateTime } from '../lib/time.ts';
import { Badge, Button, Callout, Dialog, ErrorBox, Panel, Select, TextArea } from './ui.tsx';

const tickKey = (cardId: string) => `aom.qa.ticks.${cardId}`;

/** Ticks are a private aid kept in this browser; the page works without them. */
function loadTicks(cardId: string): number[] {
  try {
    const raw = window.localStorage.getItem(tickKey(cardId));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

function saveTicks(cardId: string, ticks: number[]) {
  try {
    window.localStorage.setItem(tickKey(cardId), JSON.stringify(ticks));
  } catch {
    // private window or blocked storage: the ticks just do not stick
  }
}

/** The agent's test steps as a checklist grouped by scenario. */
export function QaChecklist({ cardId, steps }: { cardId: string; steps: string }) {
  const scenarios = useMemo(() => parseQaSteps(steps), [steps]);
  const [ticks, setTicks] = useState<number[]>([]);
  useEffect(() => setTicks(loadTicks(cardId)), [cardId]);
  const total = countSteps(scenarios);
  const toggle = (i: number) => {
    const next = ticks.includes(i) ? ticks.filter((t) => t !== i) : [...ticks, i];
    setTicks(next);
    saveTicks(cardId, next);
  };
  const doneCount = scenarios.reduce(
    (n, s) => n + s.items.filter((i) => i.kind === 'step' && (i.done || ticks.includes(i.index))).length,
    0,
  );
  return (
    <div data-testid="qa-steps" className="flex flex-col gap-4">
      {total > 0 && (
        <p className="text-xs text-subtle" data-testid="qa-progress">
          {doneCount} of {total} steps ticked
        </p>
      )}
      {scenarios.map((s, si) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static parsed list
        <section key={si} data-testid="qa-scenario">
          {s.title && <h3 className="mb-1 text-sm font-semibold text-fg">{s.title}</h3>}
          <ul className="flex flex-col gap-1.5">
            {s.items.map((item) =>
              item.kind === 'step' ? (
                <li key={item.index}>
                  <label className="flex items-start gap-2 text-sm text-fg">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={item.done || ticks.includes(item.index)}
                      onChange={() => toggle(item.index)}
                      data-testid="qa-step"
                    />
                    <span>{item.text}</span>
                  </label>
                </li>
              ) : (
                <li key={item.index} className="pl-6 text-sm text-muted">
                  {item.text}
                </li>
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}

const STATE_LABEL: Record<CardQa['state'], string> = {
  steps: 'Writing the test steps',
  open: 'Waiting for the test',
  passed: 'Passed',
  skipped: 'Skipped (not tested)',
  sent_back: 'Sent back',
};

/**
 * Manual QA on the card page (docs/design/manual-qa.md): the test steps, who tests, the held ticket update, and the
 * actions: pass, skip, send back with a comment, hand over to another member.
 */
export function QaPanel({ cardId, qa }: { cardId: string; qa: CardQa }) {
  const pass = useQaPass(cardId);
  const skip = useQaSkip(cardId);
  const sendBack = useQaSendBack(cardId);
  const assign = useQaAssign(cardId);
  const [note, setNote] = useState('');
  const [dialog, setDialog] = useState<'send_back' | 'assign' | null>(null);
  const [comment, setComment] = useState('');
  const [member, setMember] = useState('');
  const open = qa.state === 'open' || qa.state === 'steps';
  const busy = pass.isPending || skip.isPending || sendBack.isPending || assign.isPending;
  const others = qa.members.filter((m) => m.userId !== qa.assignee.userId);
  const done = (fn: () => void) => () => {
    fn();
    setNote('');
  };
  const tone =
    qa.state === 'passed'
      ? 'green'
      : qa.state === 'sent_back'
        ? 'red'
        : qa.state === 'skipped'
          ? 'neutral'
          : 'amber';

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Manual QA
          <Badge tone={tone} data-testid="qa-state">
            {STATE_LABEL[qa.state]}
          </Badge>
        </span>
      }
      data-testid="qa-panel"
    >
      <div className="flex flex-col gap-4">
        {open && (
          <p className="text-sm text-muted" data-testid="qa-assignee">
            {qa.canAct && qa.assignee.name ? (
              <>
                <span className="font-medium text-fg">{qa.assignee.name}</span> tests this card. It is merged;
                it is done when it passes or the test is skipped.
              </>
            ) : (
              <>
                Waiting for <span className="font-medium text-fg">{qa.assignee.name}</span> to test this card.
              </>
            )}
          </p>
        )}
        {qa.heldComment && (
          <Callout tone="info" title={`The update for ${qa.heldComment.externalKey} is held`}>
            It is posted to the ticket (after your approval on the desk) once QA passes or is skipped.
          </Callout>
        )}
        {qa.sentBackCount > 0 && open && (
          <p className="text-xs text-subtle" data-testid="qa-sent-back-count">
            Sent back {qa.sentBackCount} {qa.sentBackCount === 1 ? 'time' : 'times'} before.
          </p>
        )}
        {qa.steps ? (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-fg">
              What to test
              {qa.stepsBy ? <span className="font-normal text-subtle"> (written by {qa.stepsBy})</span> : ''}
            </h3>
            <QaChecklist cardId={cardId} steps={qa.steps} />
          </div>
        ) : (
          open && (
            <p className="text-sm text-subtle" data-testid="qa-no-steps">
              {qa.state === 'steps'
                ? 'An agent is writing the test steps. You can already test against the acceptance criteria on this card.'
                : 'No test steps were written. Test against the acceptance criteria and the test plan on this card.'}
            </p>
          )
        )}
        {qa.decision && (
          <p className="text-sm text-muted" data-testid="qa-decision">
            <span className="font-medium text-fg">
              {qa.decision.kind === 'passed'
                ? 'Passed'
                : qa.decision.kind === 'skipped'
                  ? 'Skipped (not tested)'
                  : 'Sent back'}
            </span>{' '}
            by {qa.decision.byName}, {formatDateTime(qa.decision.at)}
            {qa.decision.note ? `: ${qa.decision.note}` : '.'}
          </p>
        )}
        {open && qa.canAct && (
          <div className="flex flex-col gap-3 border-t border-line pt-4" data-testid="qa-actions">
            <TextArea
              label="Note (optional)"
              hint="Kept on the card. For skip, say why you did not test."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              data-testid="qa-note"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                loading={pass.isPending}
                disabled={busy}
                onClick={done(() => pass.mutate({ ...(note.trim() ? { note: note.trim() } : {}) }))}
                data-testid="qa-pass"
              >
                Pass
              </Button>
              <Button
                disabled={busy}
                loading={skip.isPending}
                onClick={done(() => skip.mutate({ ...(note.trim() ? { reason: note.trim() } : {}) }))}
                data-testid="qa-skip"
              >
                Skip the test
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => setDialog('send_back')}
                data-testid="qa-send-back"
              >
                Send back
              </Button>
              {others.length > 0 && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setDialog('assign')}
                  data-testid="qa-assign"
                >
                  Give to someone else
                </Button>
              )}
            </div>
            <ErrorBox error={pass.error ?? skip.error} />
          </div>
        )}
      </div>
      <Dialog
        open={dialog === 'send_back'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Send back for rework"
        description="The builder reads your comment as a review comment. The card goes through review, test and finalize again."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={sendBack.isPending}
              disabled={!comment.trim()}
              data-testid="qa-send-back-confirm"
              onClick={() =>
                sendBack.mutate(
                  { comment: comment.trim() },
                  {
                    onSuccess: () => {
                      setDialog(null);
                      setComment('');
                    },
                  },
                )
              }
            >
              Send back
            </Button>
          </>
        }
      >
        <TextArea
          label="What failed? (required)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={5}
          data-testid="qa-send-back-comment"
        />
        <ErrorBox error={sendBack.error} />
      </Dialog>
      <Dialog
        open={dialog === 'assign'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Give the test to someone else"
        description="They get the desk item and can pass, skip or send the card back."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={assign.isPending}
              disabled={!member}
              data-testid="qa-assign-confirm"
              onClick={() => assign.mutate({ userId: member }, { onSuccess: () => setDialog(null) })}
            >
              Hand over
            </Button>
          </>
        }
      >
        <Select
          label="Who tests it?"
          value={member}
          onChange={(e) => setMember(e.target.value)}
          data-testid="qa-assign-select"
        >
          <option value="">Pick a member</option>
          {others.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
        </Select>
        <ErrorBox error={assign.error} />
      </Dialog>
    </Panel>
  );
}
