import { useEffect, useState } from 'react';
import { useVideoInfo, VideoPlayer } from '../help/GettingStartedVideo.tsx';

/**
 * The getting-started video inside the first tour card, with captions and chapter buttons. When the video file is not
 * there (no description, or no encoding that loads) nothing is shown and the step is its text only. `onShown` tells the
 * card when the player appears, so it measures itself again and stays on screen.
 */
export function TourVideo({ onShown }: { onShown: (shown: boolean) => void }) {
  const info = useVideoInfo();
  const [broken, setBroken] = useState(false);
  const shown = info !== null && info !== 'none' && !broken;
  useEffect(() => {
    onShown(shown);
    return () => onShown(false);
  }, [shown, onShown]);
  if (!shown) return null;
  return (
    <div data-testid="tour-video" className="mt-1">
      <VideoPlayer info={info} onBroken={() => setBroken(true)} />
    </div>
  );
}
