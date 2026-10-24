/**
 * The manifest of the media container (`/videos/manifest.json`, built by media/build-manifest.mjs): which videos exist,
 * with their files, content hashes, captions, poster and duration. The help videos are shown only for slugs listed
 * here; when the manifest cannot be loaded (no media service, a network error, an HTML fallback page) every video UI
 * stays hidden: no broken players, no error toasts.
 */
export interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
  type: string;
}

export interface ManifestVideo {
  /** The encodings, by extension (`mp4`, `webm`). */
  files: Record<string, ManifestFile>;
  /** The chapters JSON (`/videos/<slug>.json`). */
  info: ManifestFile;
  captions?: ManifestFile;
  poster?: ManifestFile;
  duration?: number;
  title?: string;
}

export interface VideoManifest {
  version: number;
  hash: string;
  videos: Record<string, ManifestVideo>;
}

export const MANIFEST_URL = '/videos/manifest.json';
/** How long a failed load is remembered before the next component tries again. */
const RETRY_AFTER_MS = 60_000;

function isManifest(v: unknown): v is VideoManifest {
  const m = v as VideoManifest | null;
  return (
    !!m && typeof m === 'object' && !!m.videos && typeof m.videos === 'object' && !Array.isArray(m.videos)
  );
}

let cached: Promise<VideoManifest | null> | null = null;
let failedAt = 0;

/** The manifest, loaded once per page load (a failure is retried after a minute); null when it is unavailable. */
export function loadVideoManifest(): Promise<VideoManifest | null> {
  if (cached && (failedAt === 0 || Date.now() - failedAt <= RETRY_AFTER_MS)) return cached;
  failedAt = 0;
  const p: Promise<VideoManifest | null> = fetch(MANIFEST_URL, { headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: unknown) => (isManifest(j) ? j : null))
    .catch(() => null)
    .then((m) => {
      if (!m) failedAt = Date.now();
      return m;
    });
  cached = p;
  return p;
}

/** Forgets what was loaded (tests). */
export function resetVideoManifest(): void {
  cached = null;
  failedAt = 0;
}

/** The URL of a manifest file with its content hash: the media service serves such URLs as immutable. */
export const versionedUrl = (f: ManifestFile): string => `${f.path}?v=${f.sha256}`;

/** The slug a `/videos/<slug>.json` URL belongs to. */
export function slugOfInfoUrl(url: string): string | null {
  return /^\/videos\/([a-z0-9][a-z0-9-]*)\.json$/.exec(url)?.[1] ?? null;
}
