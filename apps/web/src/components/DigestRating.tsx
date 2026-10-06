import { type DigestItemDto, hasTranscript } from '@aom/shared';
import { useState } from 'react';
import { useRateDigestItem } from '../api/queries/digest.ts';
import { VERDICTS, verdictTone } from '../lib/feeds.ts';
import { safeHref } from '../lib/links.ts';
import { TranscriptExpander } from './Transcript.tsx';
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
      className="rounded-card border border-line bg-surface p-3"
      data-testid={`digest-item-${item.id}`}
      data-verdict={item.verdict ?? ''}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-subtle">
        <Badge tone="blue">{item.kind}</Badge>
        <span>{item.source}</span>
        {item.publishedAt && <span>· {item.publishedAt.slice(0, 10)}</span>}
        <span>· {item.cardRef}</span>
      </div>
      {safeHref(item.url) ? (
        <a
          href={safeHref(item.url)}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-1.5 block text-base font-medium text-brand-text hover:underline"
        >
          {item.title}
        </a>
      ) : (
        <span className="mt-1.5 block text-base font-medium text-fg" data-testid="unsafe-link">
          {item.title}
        </span>
      )}
      <p className="mt-1 text-sm text-muted">{item.summary}</p>
      {hasTranscript(item.kind) && (
        <TranscriptExpander
          projectId={item.projectId}
          url={item.url}
          available={item.transcript?.status === 'ok'}
        />
      )}
      {rated && item.verdict ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm" data-testid="verdict">
          <Badge tone={verdictTone(item.verdict)}>{VERDICTS.find((v) => v.id === item.verdict)?.label}</Badge>
          {item.verdictReason && <span className="text-subtle">{item.verdictReason}</span>}
          {canRate && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Change
            </Button>
          )}
        </p>
      ) : canRate ? (
        <div className="mt-2 flex flex-col gap-2">
          <label className="text-xs text-subtle">
            <span className="sr-only">Reason for {item.title}</span>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why? (optional)"
              className="h-9 w-full rounded-control border border-control bg-surface px-3 text-sm text-fg placeholder:text-subtle"
            />
          </label>
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Rate {item.title}</legend>
            {VERDICTS.map((v) => (
              <Button
                key={v.id}
                size="sm"
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
