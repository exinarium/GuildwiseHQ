import type { ShiftDto } from '@aom/shared';
import { useEffect, useState } from 'react';
import { useKillTools, useStopShift } from '../api/queries/shifts.ts';
import { Badge, Button, Dialog, useToast } from './ui.tsx';

/** "12 min", "2 h 5 min", "just now". */
export function minutesWord(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** When the shift last did anything: its newest progress line, else its start. */
export function lastActivityAt(shift: Pick<ShiftDto, 'startedAt' | 'progressTail'>): string {
  return shift.progressTail.at(-1)?.at ?? shift.startedAt;
}

function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** "Running 12 min" and "last activity 3 min ago" (quiet for a long time turns amber). */
export function ShiftClock({ shift }: { shift: Pick<ShiftDto, 'startedAt' | 'progressTail'> }) {
  const now = useNow();
  const quiet = now - new Date(lastActivityAt(shift)).getTime();
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="shift-clock">
      <Badge tone="info">Running {minutesWord(now - new Date(shift.startedAt).getTime())}</Badge>
      <Badge tone={quiet > 10 * 60_000 ? 'warning' : 'neutral'}>
        last activity {quiet < 60_000 ? 'just now' : `${minutesWord(quiet)} ago`}
      </Badge>
    </span>
  );
}

/**
 * Stop controls of a running shift (backlog #53): "Stop the running command" keeps the agent going (its commands are
 * killed and it sees them fail); "Stop shift" ends the shift (the work in the worktree is saved), and for a card it
 * asks whether the card goes back in the queue or stays with this agent.
 */
export function ShiftStopControls({
  shift,
  size = 'sm',
}: {
  shift: Pick<ShiftDto, 'id' | 'cardId' | 'cardRef' | 'agentName'>;
  size?: 'sm' | 'md';
}) {
  const stop = useStopShift();
  const kill = useKillTools();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const who = shift.agentName ? `${shift.agentName}'s shift` : 'the shift';
  const done = (text: string) => ({
    onSuccess: () => {
      setOpen(false);
      toast.success(text);
    },
    onError: () => setOpen(false),
  });
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size={size}
        data-testid="kill-tools"
        loading={kill.isPending}
        title="Kills the commands the agent is running and lets it go on. Use it when a test run or build hangs."
        onClick={() => kill.mutate(shift.id, done('Asked the runner to stop the running command'))}
      >
        Stop the running command
      </Button>
      <Button size={size} variant="danger" data-testid="stop-shift" onClick={() => setOpen(true)}>
        Stop shift
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={`Stop ${who}?`}
        description="The agent stops and every command it runs is killed. The work in its worktree is saved."
        footer={
          <Button onClick={() => setOpen(false)} data-testid="stop-cancel">
            Keep running
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {shift.cardId ? (
            <>
              <Button
                data-testid="stop-requeue"
                loading={stop.isPending && !stop.variables?.keepCard}
                onClick={() =>
                  stop.mutate(
                    { shiftId: shift.id },
                    done(`${shift.cardRef ?? 'The card'} is back in the queue`),
                  )
                }
              >
                Stop and re-queue
              </Button>
              <p className="-mt-2 text-sm text-subtle">
                The card goes back in the queue; any available agent can take it.
              </p>
              <Button
                variant="primary"
                data-testid="stop-keep"
                loading={stop.isPending && !!stop.variables?.keepCard}
                onClick={() =>
                  stop.mutate(
                    { shiftId: shift.id, keepCard: true },
                    done(`${shift.cardRef ?? 'The card'} stays with the agent, which starts a fresh shift`),
                  )
                }
              >
                Stop, keep the card with this agent
              </Button>
              <p className="-mt-2 text-sm text-subtle">
                The agent starts a fresh shift on the same card straight away.
              </p>
            </>
          ) : (
            <Button
              variant="danger"
              data-testid="stop-confirm"
              loading={stop.isPending}
              onClick={() => stop.mutate({ shiftId: shift.id }, done('Shift stopped'))}
            >
              Stop shift
            </Button>
          )}
        </div>
      </Dialog>
    </span>
  );
}
