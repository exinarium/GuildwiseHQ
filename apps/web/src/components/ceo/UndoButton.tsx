import { useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import { useUndoCeoAction } from '../../api/queries/ceo.ts';
import { Button, ConfirmDialog, useToast } from '../ui.tsx';

/**
 * Undo one action of the CEO (Owner only): asks first, posts, and shows what the server says happened. A 409 (it can
 * no longer be undone) shows the server's own words and leaves the dialog open.
 */
export function UndoButton({
  actionId,
  label = 'Undo',
  what,
  onDone,
}: {
  actionId: string;
  label?: string;
  /** What is undone, for the confirmation ("Release card TOY-4"). */
  what?: string;
  onDone?: (message: string) => void;
}) {
  const undo = useUndoCeoAction();
  const toast = useToast();
  const [ask, setAsk] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  if (result)
    return (
      <span role="status" className="text-sm text-muted" data-testid={`undo-result-${actionId}`}>
        {result}
      </span>
    );
  return (
    <>
      <Button
        size="sm"
        data-testid={`undo-${actionId}`}
        onClick={() => {
          undo.reset();
          setAsk(true);
        }}
      >
        {label}
      </Button>
      <ConfirmDialog
        open={ask}
        onOpenChange={setAsk}
        title="Undo this action?"
        description={
          what
            ? `${what}. The CEO is told, and learns from your choice.`
            : 'The CEO is told, and learns from your choice.'
        }
        confirmLabel="Undo"
        tone="primary"
        pending={undo.isPending}
        onConfirm={() =>
          undo.mutate(actionId, {
            onSuccess: (r) => {
              setResult(r.message);
              setAsk(false);
              toast.success(r.message);
              onDone?.(r.message);
            },
          })
        }
      >
        {undo.isError && (
          <p role="alert" className="text-sm font-medium text-danger" data-testid="undo-error">
            {errorMessage(undo.error)}
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
