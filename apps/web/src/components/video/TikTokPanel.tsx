import type { TikTokOptions } from '@aom/shared';
import { useEffect, useId, useMemo, useState } from 'react';
import { type TikTokCreator, useTikTokCreator } from '../../api/queries/video.ts';
import { Callout, ErrorBox, ListSkeleton } from '../ui.tsx';

const PRIVACY_LABEL: Record<string, string> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends (people you follow who follow you)',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me',
};
const MUSIC_URL = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
const BRANDED_URL = 'https://www.tiktok.com/legal/page/global/bc-policy/en';

/** What the panel reports up: the options to send (null until they are complete) and why Schedule must wait. */
export interface TikTokState {
  options: TikTokOptions | null;
  /** Shown beside a disabled Schedule button. */
  blocker: string | null;
}

type Privacy = TikTokOptions['privacy'];

/**
 * The TikTok step of the Schedule screen, built to TikTok's Direct Post rules: creator info fetched live, the privacy
 * chosen by hand (no default), interaction toggles unchecked (greyed when the creator turned them off), the commercial
 * disclosure off by default, and the consent tick before anything can be scheduled.
 */
export function TikTokPanel({
  durationSeconds,
  onChange,
  onConnection,
}: {
  /** Length of the rendered video when known (checked against the creator's maximum). */
  durationSeconds: number | null;
  onChange: (s: TikTokState) => void;
  /** Tells the caller whether TikTok can be used at all (so it can leave TikTok out of the destinations). */
  onConnection?: (connected: boolean) => void;
}) {
  const q = useTikTokCreator(true);
  const creator = q.data?.state === 'connected' ? q.data.creator : null;
  const connected = q.data ? q.data.state === 'connected' : null;
  useEffect(() => {
    if (connected !== null) onConnection?.(connected);
  }, [connected, onConnection]);

  if (q.isPending) return <ListSkeleton label="Loading TikTok account" rows={2} />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!creator)
    return (
      <Callout tone="info" title="TikTok not connected" data-testid="tiktok-not-connected">
        Connect the TikTok account under Social sharing on the Posts tab. Until then this video is not posted
        to TikTok.
      </Callout>
    );
  return <Choices creator={creator} durationSeconds={durationSeconds} onChange={onChange} />;
}

function Choices({
  creator,
  durationSeconds,
  onChange,
}: {
  creator: TikTokCreator;
  durationSeconds: number | null;
  onChange: (s: TikTokState) => void;
}) {
  const uid = useId();
  const [privacy, setPrivacy] = useState<Privacy | ''>('');
  const [comment, setComment] = useState(false);
  const [duet, setDuet] = useState(false);
  const [stitch, setStitch] = useState(false);
  const [commercial, setCommercial] = useState(false);
  const [yourBrand, setYourBrand] = useState(false);
  const [branded, setBranded] = useState(false);
  const [consent, setConsent] = useState(false);

  // until the app is audited TikTok accepts only private posts
  const options = useMemo(
    () =>
      (creator.audited
        ? creator.privacyOptions
        : creator.privacyOptions.filter((o) => o === 'SELF_ONLY')) as Privacy[],
    [creator.audited, creator.privacyOptions],
  );
  const brandedOn = commercial && branded;
  const tooLong =
    creator.maxDurationSeconds !== null &&
    durationSeconds !== null &&
    durationSeconds > creator.maxDurationSeconds;

  const blocker = useMemo(() => {
    if (!creator.canPost) return 'TikTok says this account cannot post right now.';
    if (tooLong)
      return `The video is longer than the ${creator.maxDurationSeconds} seconds this account may post.`;
    if (options.length === 0) return 'TikTok offers no privacy option for this account.';
    if (!privacy) return 'Choose who can see the TikTok video.';
    if (commercial && !yourBrand && !branded)
      return 'Say whose brand the content promotes, or turn the disclosure off.';
    if (brandedOn && privacy === 'SELF_ONLY')
      return 'Branded content cannot be private: choose another visibility.';
    if (!consent) return 'Tick the TikTok consent line.';
    return null;
  }, [creator, tooLong, options, privacy, commercial, yourBrand, branded, brandedOn, consent]);

  useEffect(() => {
    onChange({
      blocker,
      options: blocker
        ? null
        : {
            privacy: privacy as Privacy,
            allowComment: comment && !creator.commentDisabled,
            allowDuet: duet && !creator.duetDisabled,
            allowStitch: stitch && !creator.stitchDisabled,
            commercial: {
              on: commercial,
              yourBrand: commercial && yourBrand,
              brandedContent: commercial && branded,
            },
            consent: true,
          },
    });
  }, [blocker, privacy, comment, duet, stitch, commercial, yourBrand, branded, creator, onChange]);

  const toggles = [
    ['comment', 'Allow comments', comment, setComment, creator.commentDisabled],
    ['duet', 'Allow Duet', duet, setDuet, creator.duetDisabled],
    ['stitch', 'Allow Stitch', stitch, setStitch, creator.stitchDisabled],
  ] as const;

  return (
    <div className="flex flex-col gap-3" data-testid="tiktok-panel">
      <div className="flex items-center gap-2">
        {creator.avatarUrl && (
          <img src={creator.avatarUrl} alt="" className="size-8 rounded-full" width={32} height={32} />
        )}
        <p className="text-sm text-fg">
          Posting as <strong>{creator.nickname || creator.username}</strong>
          {creator.username && creator.nickname ? (
            <span className="text-muted"> @{creator.username}</span>
          ) : null}
        </p>
      </div>
      {!creator.audited && (
        <Callout tone="info" data-testid="tiktok-unaudited">
          TikTok posts privately until the app is audited: only "Only me" is available.
        </Callout>
      )}
      {!creator.canPost && (
        <Callout tone="danger" role="alert">
          TikTok says this account cannot post right now. Try again later.
        </Callout>
      )}
      {tooLong && (
        <Callout tone="danger" role="alert">
          This video is {Math.round(durationSeconds ?? 0)} seconds; the account may post at most{' '}
          {creator.maxDurationSeconds} seconds.
        </Callout>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor={`${uid}-privacy`} className="text-sm font-medium text-fg">
          Who can see this video
        </label>
        <select
          id={`${uid}-privacy`}
          value={privacy}
          onChange={(e) => setPrivacy(e.target.value as Privacy | '')}
          data-testid="tiktok-privacy"
          className="h-9 rounded-control border border-control bg-surface px-2 text-sm text-fg"
        >
          <option value="">Choose…</option>
          {options.map((o) => (
            <option key={o} value={o} disabled={brandedOn && o === 'SELF_ONLY'}>
              {PRIVACY_LABEL[o] ?? o}
            </option>
          ))}
        </select>
        {brandedOn && <p className="text-xs text-muted">Branded content visibility cannot be private.</p>}
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium text-fg">Allow people to</legend>
        <div className="flex flex-wrap gap-4">
          {toggles.map(([key, label, value, set, off]) => (
            <label
              key={key}
              className={`flex items-center gap-2 text-sm ${off ? 'text-subtle' : 'text-fg'}`}
              title={off ? 'Turned off in your TikTok settings' : undefined}
            >
              <input
                type="checkbox"
                checked={value && !off}
                disabled={off}
                onChange={(e) => set(e.target.checked)}
                data-testid={`tiktok-${key}`}
              />
              {label}
              {off && <span className="text-xs">(off in TikTok settings)</span>}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium text-fg">Disclose video content</legend>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={commercial}
            onChange={(e) => setCommercial(e.target.checked)}
            data-testid="tiktok-commercial"
          />
          This video promotes a brand, product or service
        </label>
        {commercial && (
          <div className="ml-6 flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={yourBrand}
                onChange={(e) => setYourBrand(e.target.checked)}
                data-testid="tiktok-your-brand"
              />
              Your brand
            </label>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={branded}
                onChange={(e) => setBranded(e.target.checked)}
                data-testid="tiktok-branded"
              />
              Branded content
            </label>
            {(yourBrand || branded) && (
              <p className="text-xs text-muted" data-testid="tiktok-label-note">
                {yourBrand && branded
                  ? 'Your video will be labeled "Paid partnership" (it promotes yourself and a third party).'
                  : branded
                    ? 'Your video will be labeled "Paid partnership".'
                    : 'Your video will be labeled "Promotional content".'}
              </p>
            )}
          </div>
        )}
      </fieldset>

      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          className="mt-1"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          data-testid="tiktok-consent"
        />
        <span>
          By posting, you agree to TikTok's{' '}
          {brandedOn ? (
            <>
              <a
                className="text-brand underline"
                href={BRANDED_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Branded Content Policy
              </a>{' '}
              and{' '}
            </>
          ) : null}
          <a className="text-brand underline" href={MUSIC_URL} target="_blank" rel="noopener noreferrer">
            Music Usage Confirmation
          </a>
          .
        </span>
      </label>
      <p className="text-xs text-muted">
        After the slot, TikTok can take a few minutes to process the video before it shows on the profile.
      </p>
    </div>
  );
}
