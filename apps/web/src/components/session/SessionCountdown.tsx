import { formatCountdown, type SessionTimeDto, warnMinutesFor } from '@aom/shared';
import { Clock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../ui/cx.ts';

/** Milliseconds left of the limit now: the server's count at `asOf`, plus the time since it arrived while the clock runs. */
function useRemainingMs(time: SessionTimeDto | undefined): number | null {
  // A new count from the server restarts the local clock.
  const key = `${time?.asOf}:${time?.elapsedMs}`;
  const stamp = useRef({ key, at: Date.now() });
  if (stamp.current.key !== key) stamp.current = { key, at: Date.now() };
  const received = stamp.current.at;
  const [now, setNow] = useState(() => Date.now());
  const running = !!time?.running && !time.up;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (!time || !time.limitMinutes) return null;
  const extra = running ? Math.max(0, now - received) : 0;
  return Math.max(0, time.limitMinutes * 60_000 - time.elapsedMs - extra);
}

/** The time limit as a countdown ("like a meeting"). Nothing when the session has no limit. */
export function SessionCountdown({ time }: { time: SessionTimeDto | undefined }) {
  const left = useRemainingMs(time);
  if (!time || !time.limitMinutes || left === null) return null;
  const warn = !time.up && left <= warnMinutesFor(time.limitMinutes) * 60_000;
  const up = time.up || left === 0;
  return (
    <div className="min-w-[8rem]" data-testid="meter-countdown" data-state={up ? 'up' : warn ? 'warn' : 'ok'}>
      <p className="text-xs text-subtle">Time left</p>
      <p
        className={cx(
          'tnum flex items-center gap-1 font-medium',
          up ? 'text-danger' : warn ? 'text-warning' : 'text-fg',
        )}
      >
        <Clock aria-hidden="true" className="size-3.5" />
        <span data-testid="countdown-value">{formatCountdown(left)}</span>
        <span className="text-xs font-normal text-muted">of {time.limitMinutes} min</span>
      </p>
    </div>
  );
}

/** The five-minute warning, shown until the creator extends or the time is up. */
export function TimeWarning({
  time,
  steerer,
}: {
  time: SessionTimeDto | undefined;
  steerer: 'Chair' | 'facilitator';
}) {
  const left = useRemainingMs(time);
  if (!time || !time.limitMinutes || time.up || !time.warned || left === null) return null;
  const mins = Math.max(1, Math.ceil(left / 60_000));
  return (
    <div
      role="status"
      data-testid="time-warning"
      className="rounded-card border border-warning-fill/50 bg-warning-soft px-3 py-2 text-sm text-warning-soft-fg"
    >
      {`About ${mins} minute${mins === 1 ? '' : 's'} left. The ${steerer} is steering to wrap-up.`}
    </div>
  );
}
