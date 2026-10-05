import { Badge } from './ui.tsx';

/** Local HH:MM of an ISO time. */
export const clockLabel = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * The loop breaker holds a card back after repeated failed shifts: "backing off until HH:MM (n failures)".
 * Renders nothing when there is no back-off in force.
 */
export function BackoffBadge({
  backoff,
}: {
  backoff: { until: string; failures: number } | null | undefined;
}) {
  if (!backoff || new Date(backoff.until).getTime() <= Date.now()) return null;
  return (
    <span data-testid="backoff-badge">
      <Badge
        tone="amber"
        title="The dispatcher retries this card after the back-off. A manager can release it."
      >
        backing off until {clockLabel(backoff.until)} ({backoff.failures} failures)
      </Badge>
    </span>
  );
}
