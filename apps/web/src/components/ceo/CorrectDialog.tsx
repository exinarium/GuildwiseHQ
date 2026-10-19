import { useState } from 'react';
import { useCorrectCeo } from '../../api/queries/ceo-chat.ts';
import { Button, Callout, Dialog, ErrorBox, TextArea } from '../ui.tsx';

/** What is being corrected: one of the ids, plus words for the dialog. */
export interface CorrectTarget {
  actionId?: string;
  orderTurnId?: string;
  chatMessageId?: string;
  deskItemId?: string;
  /** "Release card TOY-4": shown under the title. */
  label: string;
  /** The action has an inverse: offer "Undo it". */
  undoLabel?: string | null;
}

/**
 * One dialog for every entry point of a correction (chat, Activity, desk, daily report; docs/design/ceo-front-door.md
 * section 7.1): "What should I have done?", "Make it a rule for next time" (on by default) and "Undo it" where the action has
 * an inverse. The server writes the memory at once.
 */
export function CorrectDialog({ target, onClose }: { target: CorrectTarget; onClose: () => void }) {
  const correct = useCorrectCeo();
  const [text, setText] = useState('');
  const [makeRule, setMakeRule] = useState(true);
  const [undo, setUndo] = useState(false);
  const [done, setDone] = useState<{ message: string; remedyResult: string | null } | null>(null);

  const submit = () => {
    if (text.trim().length < 3) return;
    correct.mutate(
      {
        ...(target.actionId ? { actionId: target.actionId } : {}),
        ...(target.orderTurnId ? { orderTurnId: target.orderTurnId } : {}),
        ...(target.chatMessageId ? { chatMessageId: target.chatMessageId } : {}),
        ...(target.deskItemId ? { deskItemId: target.deskItemId } : {}),
        text: text.trim(),
        makeRule,
        remedy: undo ? 'undo' : 'none',
      },
      { onSuccess: (r) => setDone({ message: r.message, remedyResult: r.remedyResult }) },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Correct the CEO"
      description={target.label}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              data-testid="correct-submit"
              loading={correct.isPending}
              disabled={text.trim().length < 3}
              onClick={submit}
            >
              Send correction
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="flex flex-col gap-2" data-testid="correct-done">
          <Callout tone="success" role="status">
            {done.message}
          </Callout>
          {done.remedyResult && <p className="text-sm text-muted">{done.remedyResult}</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <TextArea
            label="What should I have done?"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            hint="In your own words. The CEO keeps it, and corrections come first in everything it does."
          />
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className="size-4"
              checked={makeRule}
              onChange={(e) => setMakeRule(e.target.checked)}
              data-testid="correct-rule"
            />
            Make it a rule for next time
          </label>
          {target.undoLabel !== undefined && target.undoLabel !== null && (
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                className="size-4"
                checked={undo}
                onChange={(e) => setUndo(e.target.checked)}
                data-testid="correct-undo"
              />
              Undo it{target.undoLabel ? ` (${target.undoLabel})` : ''}
            </label>
          )}
          <ErrorBox error={correct.error} />
        </div>
      )}
    </Dialog>
  );
}

/** A "Correct" button that opens the dialog for one target. */
export function CorrectButton({
  target,
  label = 'Correct',
  testId,
}: {
  target: CorrectTarget;
  label?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} {...(testId ? { 'data-testid': testId } : {})}>
        {label}
      </Button>
      {open && <CorrectDialog target={target} onClose={() => setOpen(false)} />}
    </>
  );
}
