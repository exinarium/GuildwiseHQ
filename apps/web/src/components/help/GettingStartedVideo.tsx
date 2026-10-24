import { Clapperboard } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  loadVideoManifest,
  type ManifestVideo,
  slugOfInfoUrl,
  versionedUrl,
} from '../../lib/video-manifest.ts';
import { GETTING_STARTED_SLUG, videoInfoUrl } from '../../lib/videos.ts';

/** What the harness of `e2e/video/*.spec.ts` writes next to every video (seconds from the start). */
export interface VideoInfo {
  title: string;
  src: string;
  type: string;
  /** Every encoding, best-supported first (MP4 plays on phones and in apps; WebM is the fallback). */
  sources?: Array<{ src: string; type: string }>;
  /** WebVTT captions with the narration (optional). */
  captions?: string;
  duration: number;
  chapters: Array<{ t: number; title: string }>;
}

export const VIDEO_INFO_URL = videoInfoUrl(GETTING_STARTED_SLUG);

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function isInfo(v: unknown): v is VideoInfo {
  const i = v as VideoInfo | null;
  return !!i && typeof i.src === 'string' && Array.isArray(i.chapters);
}

/** Points the files of a description at the manifest's content-addressed URLs and drops what the media image lacks. */
function withManifest(info: VideoInfo, entry: ManifestVideo, slug: string): VideoInfo | null {
  const known = new Map<string, string>();
  for (const f of [...Object.values(entry.files), entry.captions].filter((x) => !!x))
    known.set(f.path, versionedUrl(f));
  const sources = (info.sources?.length ? info.sources : [{ src: info.src, type: info.type }])
    .filter((s) => known.has(s.src))
    .map((s) => ({ ...s, src: known.get(s.src) as string }));
  const first = sources[0];
  if (!first) return null;
  const captions = known.get(info.captions ?? `/videos/${slug}.vtt`);
  const { captions: _drop, ...rest } = info;
  return { ...rest, src: first.src, type: first.type, sources, ...(captions ? { captions } : {}) };
}

/**
 * Loads the video's description once per mounting; `null` while loading, `'none'` when there is no video (the media
 * service is down, the manifest does not list the slug, or the description cannot be read). `url` is the chapters JSON
 * (default: Getting started); `null` skips every request and stays `'none'`.
 */
export function useVideoInfo(url: string | null = VIDEO_INFO_URL): VideoInfo | null | 'none' {
  const [info, setInfo] = useState<VideoInfo | null | 'none'>(url ? null : 'none');
  useEffect(() => {
    if (!url) {
      setInfo('none');
      return;
    }
    setInfo(null);
    let live = true;
    const slug = slugOfInfoUrl(url);
    loadVideoManifest()
      .then(async (manifest) => {
        const entry = slug ? manifest?.videos[slug] : undefined;
        if (!entry) return 'none' as const;
        const r = await fetch(versionedUrl(entry.info), { headers: { accept: 'application/json' } });
        const j: unknown = r.ok ? await r.json() : null;
        return isInfo(j) ? (withManifest(j, entry, slug as string) ?? 'none') : ('none' as const);
      })
      .catch(() => 'none' as const)
      .then((result) => live && setInfo(result));
    return () => {
      live = false;
    };
  }, [url]);
  return info;
}

/**
 * The player with its captions and one button per chapter. `onBroken` is told when no encoding can be loaded. The video
 * is paused when the player goes away (the tour moves to its next step).
 */
export function VideoPlayer({
  info,
  onBroken,
  slug = GETTING_STARTED_SLUG,
}: {
  info: VideoInfo;
  onBroken: () => void;
  /** The video's slug: names the test id (`<slug>-player`) and the default captions file. */
  slug?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = video.current;
    return () => v?.pause?.();
  }, []);
  const seek = (t: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = t;
    void v.play?.()?.catch?.(() => undefined);
  };
  return (
    <>
      {/* biome-ignore lint/a11y/useMediaCaption: the captions track is rendered whenever the manifest lists one */}
      <video
        ref={video}
        controls
        preload="metadata"
        playsInline
        data-testid={`${slug}-player`}
        aria-label={info.title}
        className="aspect-video w-full rounded-control bg-black"
        onError={onBroken}
      >
        {(info.sources?.length ? info.sources : [{ src: info.src, type: info.type }]).map((s, i, all) => (
          <source
            key={s.src}
            src={s.src}
            type={s.type}
            {...(i === all.length - 1 ? { onError: onBroken } : {})}
          />
        ))}
        {/* the narration as captions (on by default; the CC button turns them off) */}
        {info.captions && <track kind="captions" src={info.captions} srcLang="en" label="English" default />}
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
  );
}

/**
 * The "Getting started" video with its chapters (the Get started checklist, a workstation, a project, a lean team, a card
 * and the BA, the Desk, the board, Help). The files live in the media container (media/videos); when the media service is
 * down, the manifest does not list the video or no encoding loads, the whole section is hidden (the written article says
 * the same).
 */
export function GettingStartedVideo() {
  const info = useVideoInfo();
  const [broken, setBroken] = useState(false);
  if (info === null || info === 'none' || broken) return null;
  return (
    <section
      aria-labelledby="gs-video-h"
      data-testid="getting-started-video"
      className="rounded-card border border-line bg-surface p-4 sm:p-5"
    >
      <h2 id="gs-video-h" className="flex items-center gap-2 text-base font-semibold text-fg">
        <Clapperboard aria-hidden="true" className="size-4 text-brand-text" />
        Getting started
      </h2>
      <p className="mt-1 mb-3 text-sm text-muted">
        A voice-over tutorial of under three minutes, from an empty organization to a team at work: the Get
        started checklist, a workstation, a project, a lean team, a first card and the business analyst, the
        Desk and the board. Captions are on; use the CC button to turn them off.
      </p>
      <VideoPlayer info={info} onBroken={() => setBroken(true)} />
    </section>
  );
}
