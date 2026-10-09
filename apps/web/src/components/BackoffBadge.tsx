import { CardNotice } from './CardNotice.tsx';
import { Badge } from './ui.tsx';

/** Local HH:MM of an ISO time. */
export const clockLabel = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

const EXPLAIN = 'The dispatcher retries this card after the back-off. A manager can release it.';

/**
 * The loop breaker holds a card back after repeated failed shifts: "backing off until HH:MM (n failures)".
 * Renders nothing when there is no back-off in force. `banner` is the board card's form: a full-width coloured line
 * on the card with the explanation one tap away; the default is the small pill of the card page.
 */
export function BackoffBadge({
  backoff,
  banner = false,
}: {
  backoff: { until: string; failures: number } | null | undefined;
  banner?: boolean;
}) {
  if (!backoff || new Date(backoff.until).getTime() <= Date.now()) return null;
  const text = `backing off until ${clockLabel(backoff.until)} (${backoff.failures} failures)`;
  if (banner) return <CardNotice testId="backoff-badge" level="warning" summary={text} detail={EXPLAIN} />;
  return (
    <span data-testid="backoff-badge">
      <Badge tone="amber" title={EXPLAIN}>
        {text}
      </Badge>
    </span>
  );
}
