import { Clapperboard } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** What `e2e/video/getting-started.spec.ts` writes next to the video (seconds from the start). */
export interface VideoInfo {
  title: string;
  src: string;
  type: string;
  /** WebVTT captions with the narration (optional). */
  captions?: string;
  duration: number;
  chapters: Array<{ t: number; title: string }>;
}

export const VIDEO_INFO_URL = '/videos/getting-started.json';

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function isInfo(v: unknown): v is VideoInfo {
  const i = v as VideoInfo | null;
  return !!i && typeof i.src === 'string' && Array.isArray(i.chapters);
}

/**
 * The "Getting started" video with its chapters (create a project, hire agents, create cards, talk to the BA, test your
 * project). The video is a static file recorded by `pnpm --filter @aom/e2e video`; until it exists, or when it cannot be
 * loaded, a short "coming soon" note takes its place (the written article below says the same).
 */
export function GettingStartedVideo() {
  const [info, setInfo] = useState<VideoInfo | null | 'none'>(null);
  const [broken, setBroken] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let live = true;
    fetch(VIDEO_INFO_URL, { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => live && setInfo(isInfo(j) ? j : 'none'))
      .catch(() => live && setInfo('none'));
    return () => {
      live = false;
    };
  }, []);
  if (info === null) return null;
  const seek = (t: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = t;
    void v.play?.()?.catch?.(() => undefined);
  };
  return (
    <section
      aria-labelledby="gs-video-h"
      data-testid="getting-started-video"
      className="rounded-card border border-line bg-surface p-4 sm:p-5"
    >
      <h2 id="gs-video-h" className="flex items-center gap-2 text-base font-semibold text-fg">
        <Clapperboard aria-hidden="true" className="size-4 text-brand-text" />
        Getting started in five steps
      </h2>
      <p className="mt-1 mb-3 text-sm text-muted">
        A voice-over tutorial of about three minutes: create your first project, hire agents, create cards,
        talk to the business analyst and test your running project. Captions are on; use the CC button to turn
        them off.
      </p>
      {info === 'none' || broken ? (
        <p
          role="status"
          data-testid="video-coming-soon"
          className="rounded-control border border-line bg-sunken px-3 py-6 text-center text-sm text-muted"
        >
          The getting-started video is coming soon. The steps are written out in the Getting started article.
        </p>
      ) : (
        <>
          <video
            ref={video}
            controls
            preload="metadata"
            playsInline
            data-testid="getting-started-player"
            aria-label={info.title}
            className="aspect-video w-full rounded-control bg-black"
            onError={() => setBroken(true)}
          >
            <source src={info.src} type={info.type} onError={() => setBroken(true)} />
            {/* the narration as captions (on by default; the CC button turns them off) */}
            <track
              kind="captions"
              src={info.captions ?? '/videos/getting-started.vtt'}
              srcLang="en"
              label="English"
              default
            />
          </video>
          <ol className="mt-3 flex flex-wrap gap-2" aria-label="Chapters">
            {info.chapters.map((c, i) => (
              <li key={c.title}>
                <button
                  type="button"
                  onClick={() => seek(c.t)}
                  data-testid={`video-chapter-${i + 1}`}
                  className="inline-flex min-h-9 items-center gap-2 rounded-control border border-control bg-surface px-3 text-sm text-fg hover:bg-sunken"
                >
                  <span className="tnum text-xs text-subtle">{clock(c.t)}</span>
                  {i + 1}. {c.title}
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
