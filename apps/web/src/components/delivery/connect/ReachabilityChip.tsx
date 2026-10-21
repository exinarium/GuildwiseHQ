import { type ConnectionState, REACHABILITY_TEXT, type ReachabilityDto } from '@aom/shared';
import { agoText } from '../../../lib/ago.ts';
import { Badge } from '../../ui.tsx';

const TONE = { success: 'green', warning: 'amber', danger: 'red', neutral: 'neutral' } as const;

/**
 * "Can the computer that deploys this server sign in to it?" as a chip on a target card (design v2, J5): the state in plain
 * words, how it signs in (Guildwise key or the sign-in the computer already has) and when it was last checked.
 */
export function ReachabilityChip({
  reachability,
  testId = 'reachability-chip',
}: {
  reachability: ReachabilityDto | null | undefined;
  testId?: string;
}) {
  const state: ConnectionState | 'never' = reachability?.state ?? 'never';
  const t = REACHABILITY_TEXT[state];
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid={testId}>
      <Badge tone={TONE[t.tone]} data-testid="reachability-state">
        {t.text}
      </Badge>
      {reachability && (
        <span className="text-xs text-subtle" data-testid="reachability-detail">
          {reachability.method === 'deploy_key'
            ? 'with its own Guildwise key'
            : 'with the computer’s own sign-in'}
          , checked {agoText(reachability.at)}
        </span>
      )}
    </span>
  );
}

/** Should the card offer "Reconnect"? The deploying computer cannot sign in to the server, or was never checked. */
export function needsReconnect(reachability: ReachabilityDto | null | undefined): boolean {
  return !reachability || reachability.state !== 'reachable';
}
