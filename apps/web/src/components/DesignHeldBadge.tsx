import type { BoardCard } from '@aom/shared';
import { Badge } from './ui.tsx';

const EXPLAIN =
  "The architect's design is done. It moves on once these cards have merged; the architect then re-checks its assumptions.";

/** The badge text of a held design: "Design ready · waiting for P5-34, P5-35 +1" or "Design ready · re-check queued". */
export function designHeldLabel(held: NonNullable<BoardCard['designHeld']>): string {
  const refs = held.waitingFor;
  if (refs.length === 0) return 'Design ready · re-check queued';
  const shown = refs.slice(0, 2).join(', ');
  return `Design ready · waiting for ${shown}${refs.length > 2 ? ` +${refs.length - 2}` : ''}`;
}

/** Neutral badge on a board card whose design waits for its dependencies to land (not an error). */
export function DesignHeldBadge({ held }: { held: BoardCard['designHeld'] }) {
  if (!held) return null;
  return (
    <span data-testid="design-held" className="block">
      <Badge tone="info" title={EXPLAIN}>
        {designHeldLabel(held)}
      </Badge>
    </span>
  );
}
