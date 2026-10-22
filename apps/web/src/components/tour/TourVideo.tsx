import { useEffect, useState } from 'react';
import { GETTING_STARTED_SLUG, publishedVideo, videoInfoUrl } from '../../lib/videos.ts';
import { useVideoInfo, VideoPlayer } from '../help/GettingStartedVideo.tsx';

/**
 * A video inside a tour card, with captions and chapter buttons: the getting-started video on the first step (the
 * default) or the video of the section a step explains (`slug`, only when it is published). When the video file is not
 * there (no description, or no encoding that loads) nothing is shown and the step is its text only. `onShown` tells the
 * card when the player appears, so it measures itself again and stays on screen.
 */
export function TourVideo({
  onShown,
  slug = GETTING_STARTED_SLUG,
}: {
  onShown: (shown: boolean) => void;
  slug?: string;
}) {
  const allowed = !!publishedVideo(slug);
  const info = useVideoInfo(allowed ? videoInfoUrl(slug) : null);
  const [broken, setBroken] = useState(false);
  const shown = info !== null && info !== 'none' && !broken;
  useEffect(() => {
    onShown(shown);
    return () => onShown(false);
  }, [shown, onShown]);
  if (!shown) return null;
  return (
    <div data-testid="tour-video" className="mt-1">
      <VideoPlayer info={info} slug={slug} onBroken={() => setBroken(true)} />
    </div>
  );
}
