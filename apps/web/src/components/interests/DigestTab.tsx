import type { DigestItemDto, InterestDto } from '@aom/shared';
import { useState } from 'react';
import { useInterestDigest } from '../../api/queries/interests.ts';
import { DigestItemRow } from '../DigestRating.tsx';
import { Button, EmptyState, ErrorBox, ListSkeleton } from '../ui.tsx';
import { ResearchThisDialog } from './ResearchThisDialog.tsx';

/** The running list across all runs (what deliveries put on your desk), newest first, with ratings and "Research this". */
export function DigestTab({ interest }: { interest: InterestDto }) {
  const items = useInterestDigest(interest.id);
  const [onlyUnrated, setOnlyUnrated] = useState(false);
  const [researching, setResearching] = useState<DigestItemDto | null>(null);
  const shown = [...(items.data ?? [])].reverse().filter((i) => !onlyUnrated || i.verdict === null);
  return (
    <div className="flex flex-col gap-3" data-testid="digest-tab">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-h-9 items-center gap-2 text-sm [@media(pointer:coarse)]:min-h-11">
          <input
            type="checkbox"
            checked={onlyUnrated}
            data-testid="digest-unrated"
            onChange={(e) => setOnlyUnrated(e.target.checked)}
          />
          Only unrated
        </label>
        {interest.stats.items.held > 0 && (
          <span className="text-sm text-muted" data-testid="digest-held">
            {interest.stats.items.held} more waiting for the next delivery.
          </span>
        )}
      </div>
      {items.isPending && <ListSkeleton label="Loading the digest" rows={3} />}
      <ErrorBox error={items.error} onRetry={() => items.refetch()} />
      {items.data && shown.length === 0 && (
        <EmptyState
          title={onlyUnrated ? 'Everything is rated' : 'Nothing delivered yet'}
          description="Items appear here when a delivery puts them on your desk."
        />
      )}
      <ul className="flex flex-col gap-2" aria-label="Digest items" data-testid="digest-items">
        {shown.map((i) => (
          <li key={i.id} className="flex flex-col gap-1">
            <DigestItemRow item={i} canRate />
            <div>
              {interest.canManage && !interest.archived && (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="item-research"
                  onClick={() => setResearching(i)}
                >
                  Research this item
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {researching && (
        <ResearchThisDialog
          interest={interest}
          item={{ id: researching.id, title: researching.title }}
          onClose={() => setResearching(null)}
        />
      )}
    </div>
  );
}
