import {
  captionLength,
  composeCaption,
  HASHTAG_RE,
  SOCIAL_LIMITS,
  SOCIAL_NETWORKS,
  type SocialCaptions,
  type SocialNetwork,
  X_LINK_SAMPLE,
} from '@aom/shared';
import { type KeyboardEvent, useState } from 'react';
import { TextArea } from '../ui.tsx';

const NAMES: Record<SocialNetwork, string> = {
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  x: 'X',
  bluesky: 'Bluesky',
};
const TEXT_KEY = {
  facebook: 'facebookText',
  linkedin: 'linkedinText',
  x: 'xText',
  bluesky: 'blueskyText',
} as const satisfies Record<SocialNetwork, keyof SocialCaptions>;

/** The text limit a network's counter runs against (`text` for Facebook/LinkedIn, `total` for X/Bluesky). */
export const limitOf = (n: SocialNetwork): number => {
  const l = SOCIAL_LIMITS[n];
  return 'text' in l ? l.text : l.total;
};

/** What the editor counts and previews for one network: exactly what `composeCaption` posts. */
export function captionStats(n: SocialNetwork, c: SocialCaptions, fallback = '') {
  const text = c[TEXT_KEY[n]] ?? '';
  const tags = c.hashtags?.[n] ?? [];
  const link = n === 'x' ? X_LINK_SAMPLE : '';
  const composed = composeCaption(n, text || fallback, tags, link).text;
  // X and Bluesky: the caption and its tags share the limit; the counter is what is composed (before any cut) so an overflow shows.
  const raw =
    n === 'x' || n === 'bluesky' ? [text, ...tags.map((t) => `#${t}`)].filter(Boolean).join(' ') : text;
  const count =
    n === 'x' || n === 'bluesky' ? captionLength(n, raw.replace(/\s+/g, ' ')) : captionLength(n, text);
  return { composed, count, max: limitOf(n), over: count > limitOf(n) };
}

function TagInput({
  network,
  tags,
  onChange,
}: {
  network: SocialNetwork;
  tags: string[];
  onChange: (t: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const [min, max] = SOCIAL_LIMITS[network].tags;
  const add = (raw: string) => {
    const t = raw.trim().replace(/^[#＃]/, '');
    if (!t) return;
    if (!HASHTAG_RE.test(t) || tags.some((x) => x.toLowerCase() === t.toLowerCase()) || tags.length >= max)
      return;
    onChange([...tags, t]);
    setDraft('');
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1));
  };
  const short = tags.length < min;
  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-xs text-fg"
            data-testid={`tag-${network}-${t}`}
          >
            #{t}
            <button
              type="button"
              aria-label={`Remove #${t}`}
              className="text-muted hover:text-fg"
              onClick={() => onChange(tags.filter((x) => x !== t))}
            >
              ×
            </button>
          </span>
        ))}
        {tags.length < max && (
          <input
            aria-label={`Add a hashtag for ${NAMES[network]}`}
            className="min-w-[8rem] flex-1 rounded-control border border-control bg-transparent px-2 py-1 text-xs"
            placeholder="Add hashtag, press Enter"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={key}
            onBlur={() => add(draft)}
          />
        )}
      </div>
      <p
        className={`mt-1 text-xs ${short ? 'text-warning' : 'text-muted'}`}
        data-testid={`tags-count-${network}`}
      >
        {tags.length} of {min === max ? max : `${min}-${max}`} hashtags
      </p>
    </div>
  );
}

/**
 * One caption per network with its hashtags, a live counter and the exact text that will be posted. X counts the
 * link as 23 characters; Bluesky has no link in its text (the link card carries it).
 */
export function SocialCaptionsEditor({
  value,
  onChange,
  fallback = '',
}: {
  value: SocialCaptions;
  onChange: (v: SocialCaptions) => void;
  /** Used when a caption is empty (the post summary): what the network would get. */
  fallback?: string;
}) {
  const setText = (n: SocialNetwork, text: string) => onChange({ ...value, [TEXT_KEY[n]]: text });
  const setTags = (n: SocialNetwork, tags: string[]) =>
    onChange({ ...value, hashtags: { ...value.hashtags, [n]: tags } });
  return (
    <div className="grid gap-4 sm:grid-cols-2" data-testid="social-captions-editor">
      {SOCIAL_NETWORKS.map((n) => {
        const st = captionStats(n, value, fallback);
        return (
          <div key={n} data-testid={`caption-${n}`}>
            <TextArea
              label={`${NAMES[n]} caption`}
              rows={3}
              value={value[TEXT_KEY[n]] ?? ''}
              onChange={(e) => setText(n, e.target.value)}
              hint={
                n === 'x'
                  ? 'The link counts as 23 characters and is added for you.'
                  : n === 'bluesky'
                    ? 'No link in the text: the link card carries it.'
                    : undefined
              }
            />
            <p
              className={`mt-1 text-xs ${st.over ? 'font-medium text-danger' : 'text-muted'}`}
              data-testid={`counter-${n}`}
            >
              {st.count} / {st.max}
              {n === 'x'
                ? ' (hashtags included, link excluded)'
                : n === 'bluesky'
                  ? ' (hashtags included)'
                  : ' (hashtags added below)'}
            </p>
            <TagInput network={n} tags={value.hashtags?.[n] ?? []} onChange={(t) => setTags(n, t)} />
            <pre
              className="mt-2 whitespace-pre-wrap rounded-control bg-sunken p-2 text-xs text-fg"
              data-testid={`preview-${n}`}
            >
              {st.composed}
            </pre>
          </div>
        );
      })}
    </div>
  );
}
