import { Clapperboard } from 'lucide-react';
import { useState } from 'react';
import { useOrgTerms } from '../../lib/terms.ts';
import { publishedVideo, videoForPath, videoInfoUrl } from '../../lib/videos.ts';
import { Button } from '../ui.tsx';
import { useVideoInfo, VideoPlayer } from './GettingStartedVideo.tsx';

/**
 * The player of one section video, with its title and chapter buttons. It renders nothing unless the slug is
 * registered and published (lib/videos.ts) AND its chapters JSON loads, and nothing when no encoding can be played:
 * a video that has not been recorded is never advertised, not even as "coming soon".
 */
export function SectionVideo({ slug, className }: { slug: string; className?: string }) {
  const t = useOrgTerms();
  const entry = publishedVideo(slug);
  const info = useVideoInfo(entry ? videoInfoUrl(slug) : null);
  const [broken, setBroken] = useState(false);
  if (!entry || info === null || info === 'none' || broken) return null;
  return (
    <section
      aria-label={`Video: ${t.reword(entry.title)}`}
      data-testid={`section-video-${slug}`}
      className={className ?? 'rounded-card border border-line bg-surface p-4 sm:p-5'}
    >
      <h3 className="mb-2 flex items-center gap-2 text-base font-semibold text-fg">
        <Clapperboard aria-hidden="true" className="size-4 text-brand-text" />
        {t.reword(entry.title)}
      </h3>
      <VideoPlayer info={info} slug={slug} onBroken={() => setBroken(true)} />
    </section>
  );
}

/**
 * The "Watch the video" button of a page's help panel: shown only when the page's section has a published video whose
 * chapters JSON loads. It opens the player in place.
 */
export function PageVideo({ pathname }: { pathname: string }) {
  const found = videoForPath(pathname);
  const info = useVideoInfo(found ? videoInfoUrl(found.slug) : null);
  const [open, setOpen] = useState(false);
  if (!found || info === null || info === 'none') return null;
  return (
    <div className="mb-4" data-testid="page-video">
      <Button
        variant="secondary"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="page-video-button"
      >
        <Clapperboard aria-hidden="true" className="size-4" />
        {open ? 'Hide the video' : 'Watch the video'}
      </Button>
      {open && <SectionVideo slug={found.slug} className="mt-3" />}
    </div>
  );
}
