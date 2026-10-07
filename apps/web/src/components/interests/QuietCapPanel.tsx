import { useState } from 'react';
import { useUpdateReporting } from '../../api/queries/reporting.ts';
import { Button, ErrorBox, Panel, TextInput, useToast } from '../ui.tsx';

/**
 * The organization's quiet cap: the most digest items that may reach the desk per day across all interests. The Owner
 * and Admins change it; everyone sees it.
 */
export function QuietCapPanel({
  cap,
  deliveredToday,
  canEdit,
}: {
  cap: number | null;
  deliveredToday: number;
  canEdit: boolean;
}) {
  const update = useUpdateReporting();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(cap == null ? '' : String(cap));
  const parsed = text.trim() === '' ? null : Number.parseInt(text, 10);
  const bad = parsed !== null && (!Number.isFinite(parsed) || parsed < 1 || parsed > 1000);
  return (
    <Panel data-testid="quiet-cap">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-fg">Daily quiet cap</h2>
          <p className="text-sm text-muted" data-testid="quiet-cap-line">
            {cap == null
              ? 'No limit on the digest items that reach your desk.'
              : `At most ${cap} digest ${cap === 1 ? 'item' : 'items'} a day reach your desk, across all interests.`}{' '}
            <span className="text-subtle">{deliveredToday} delivered in the last 24 hours.</span>
          </p>
        </div>
        {canEdit && !editing && (
          <Button data-testid="quiet-cap-edit" onClick={() => setEditing(true)}>
            Change
          </Button>
        )}
      </div>
      {editing && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="w-40">
            <TextInput
              label="Items per day"
              hint="Empty means no limit."
              inputMode="numeric"
              value={text}
              error={bad ? '1 to 1000' : undefined}
              data-testid="quiet-cap-input"
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <Button
            variant="primary"
            disabled={bad}
            loading={update.isPending}
            data-testid="quiet-cap-save"
            onClick={() =>
              update.mutate(
                { interestDigestCap: parsed },
                {
                  onSuccess: () => {
                    toast.success('Quiet cap saved');
                    setEditing(false);
                  },
                },
              )
            }
          >
            Save
          </Button>
          <Button onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      )}
      <ErrorBox error={update.error} />
    </Panel>
  );
}
