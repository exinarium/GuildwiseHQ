import { SESSION_TIME_EXTEND_CHOICES, type SessionTimeAction } from '@aom/shared';
import { Button, Callout, ErrorBox } from '../ui.tsx';

/** "Time is up": the creator extends the session or wraps it up; everyone else waits. Nothing new starts meanwhile. */
export function TimeUpCard({
  canManage,
  wrapLabel,
  busy,
  error,
  onAction,
}: {
  canManage: boolean;
  wrapLabel: string;
  busy: boolean;
  error: unknown;
  onAction: (a: SessionTimeAction) => void;
}) {
  return (
    <Callout tone="warning" role="alert" title="The time limit is up" data-testid="time-up">
      <p>Nothing new starts until the creator decides.</p>
      {canManage ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {SESSION_TIME_EXTEND_CHOICES.map((m) => (
            <Button
              key={m}
              size="sm"
              disabled={busy}
              onClick={() => onAction({ action: 'extend', minutes: m })}
              data-testid={`extend-${m}`}
            >
              {`Extend +${m} min`}
            </Button>
          ))}
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => onAction({ action: 'wrap_up' })}
            data-testid="wrap-up"
          >
            {wrapLabel}
          </Button>
        </div>
      ) : (
        <p className="mt-1">Waiting for the session creator to extend or wrap up.</p>
      )}
      <ErrorBox error={error} />
    </Callout>
  );
}
