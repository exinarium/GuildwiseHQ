import type { DigestItemDto } from '@aom/shared';
import { useState } from 'react';
import { useRateDigestItem } from '../api/queries/digest.ts';
import { VERDICTS, verdictTone } from '../lib/feeds.ts';
import { Badge, Button, ErrorBox } from './ui.tsx';

/**
 * A digest on the desk: every item gets a quick verdict (useful, irrelevant, boring) with an optional reason. The
 * verdicts become explicit rules in `taste.md`, never an opaque score.
 */
export function DigestRating({ items, canRate }: { items: DigestItemDto[]; canRate: boolean }) {
  return (
    <ul className="mt-3 flex flex-col gap-2" aria-label="Digest items" data-testid="digest-items">
      {items.map((item) => (
        <li key={item.id}>
          <DigestItemRow item={item} canRate={canRate} />
        </li>
      ))}
    </ul>
  );
}

export function DigestItemRow({ item, canRate }: { item: DigestItemDto; canRate: boolean }) {
  const rate = useRateDigestItem();
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const rated = item.verdict !== null && !editing;
  return (
    <div
      className="rounded-md border border-zinc-200 p-2 dark:border-zinc-700"
      data-testid={`digest-item-${item.id}`}
      data-verdict={item.verdict ?? ''}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
        <Badge tone="blue">{item.kind}</Badge>
        <span>{item.source}</span>
        {item.publishedAt && <span>· {item.publishedAt.slice(0, 10)}</span>}
        <span>· {item.cardRef}</span>
      </div>
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-1 block text-sm font-medium underline"
      >
        {item.title}
      </a>
      <p className="mt-0.5 text-sm text-zinc-700 dark:text-zinc-300">{item.summary}</p>
      {rated && item.verdict ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm" data-testid="verdict">
          <Badge tone={verdictTone(item.verdict)}>{VERDICTS.find((v) => v.id === item.verdict)?.label}</Badge>
          {item.verdictReason && <span className="text-zinc-500">{item.verdictReason}</span>}
          {canRate && (
            <Button variant="ghost" onClick={() => setEditing(true)}>
              Change
            </Button>
          )}
        </p>
      ) : canRate ? (
        <div className="mt-2 flex flex-col gap-2">
          <label className="text-xs text-zinc-500">
            <span className="sr-only">Reason for {item.title}</span>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why? (optional)"
              className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Rate {item.title}</legend>
            {VERDICTS.map((v) => (
              <Button
                key={v.id}
                title={v.hint}
                disabled={rate.isPending}
                onClick={() =>
                  rate.mutate(
                    {
                      id: item.id,
                      body: { verdict: v.id, ...(reason.trim() ? { reason: reason.trim() } : {}) },
                    },
                    {
                      onSuccess: () => {
                        setEditing(false);
                        setReason('');
                      },
                    },
                  )
                }
              >
                {v.label}
              </Button>
            ))}
          </fieldset>
          <ErrorBox error={rate.error} />
        </div>
      ) : null}
    </div>
  );
}
