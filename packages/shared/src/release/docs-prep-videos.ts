/**
 * Release prep (docs and videos): the 'Generate videos' step. Pure: the registry entry, the screen map schema, the rule
 * that maps the changed files of a release to the help videos to re-render or create, the step report and the check of
 * the voice label against the existing videos. No I/O.
 */
import { z } from 'zod';
import { globToRegExp } from '../workflows/high-risk.ts';
import type { ReleaseDocsPrepStepDef } from './docs-prep.ts';

export const VIDEOS_STEP: ReleaseDocsPrepStepDef = {
  id: 'videos',
  label: 'Generate videos',
  description:
    'Re-renders the help videos whose screens changed and records new ones (slow; needs the voice, ffmpeg and browsers on the workstation).',
  order: 40,
  defaultOn: false,
  producesFiles: true,
  phases: ['plan', 'author', 'render'],
  serverPhases: ['author'],
};

/** Where a repository keeps its screen map. Without it, the repository has no video harness. */
export const VIDEO_SCREEN_MAP_PATH = 'e2e/video/screens.json';
/** The inputs hash of each rendered video (idempotency across runs). */
export const VIDEO_RENDERS_PATH = 'e2e/video/renders.json';
export const VIDEO_OUT_DIR = 'media/videos';
/** The four files a rendered video is made of, in the existing format. */
export const VIDEO_FILE_EXTS = ['webm', 'mp4', 'vtt', 'json'] as const;
export const NO_VIDEO_HARNESS_NOTE = 'skipped: no videos';
export const NO_NEW_VIDEOS_NOTE = 'no new videos';

const Globs = z.array(z.string().min(1)).default([]);

export const VideoScreenMapSchema = z.object({
  version: z.literal(1),
  /** Only these files can select a video. */
  ui: Globs,
  /** Page-level files: an unmapped one asks for a new video. */
  pages: Globs,
  /** Shared UI: selects nothing, so a sidebar or token change does not re-render the library. */
  shared: Globs,
  /** Screens that never get a video. */
  exclude: Globs,
  videos: z.record(
    z.string(),
    z.object({
      screens: z.array(z.object({ name: z.string().min(1), files: z.array(z.string().min(1)).min(1) })),
    }),
  ),
  /** Registered screens that still need a first video. */
  planned: z
    .record(z.string(), z.object({ title: z.string().min(1), pages: z.array(z.string().min(1)).min(1) }))
    .default({}),
});
export type VideoScreenMap = z.infer<typeof VideoScreenMapSchema>;

export const VideoRendersSchema = z.record(
  z.string(),
  z.object({ inputs: z.string(), sourceSha: z.string(), voice: z.string() }),
);
export type VideoRenders = z.infer<typeof VideoRendersSchema>;

export const VIDEO_RULE_TEXT =
  'A changed spec or narration re-renders its video; shared UI (shell, ui, styles, api, lib) re-renders nothing; a changed file listed under a screen of a video in e2e/video/screens.json re-renders every video that lists it; a new or changed page in no video asks for a new video (its planned entry, else the file name); other UI files select nothing; non-UI changes are ignored.';

export type VideoChangeStatus = 'A' | 'M' | 'D' | 'R';
export interface VideoChange {
  path: string;
  status: VideoChangeStatus;
  oldPath?: string;
}

export interface VideoMappingInput {
  changes: VideoChange[];
  map: VideoScreenMap;
  /** The slugs of the specs present (`e2e/video/<slug>.spec.ts`). */
  specs: string[];
  /** Card keys per changed path, to name them in the reasons. */
  cardsByPath?: Record<string, string[]>;
}

export interface VideoSelection {
  slug: string;
  reasons: string[];
  /** The spec does not exist: this video fails. */
  specMissing?: boolean;
}

export interface NewVideo {
  slug: string;
  title: string;
  pages: string[];
  reasons: string[];
}

export interface VideoMapping {
  rule: string;
  selected: VideoSelection[];
  newVideos: NewVideo[];
  shared: string[];
  unmapped: string[];
  ignoredCount: number;
}

const SCRIPT_RE = /^e2e\/video\/(?:narration\/([a-z0-9-]+)\.ts|([a-z0-9-]+)\.spec\.ts)$/;
const REASON_PATHS = 5;

const compile = (globs: readonly string[]) => globs.map(globToRegExp);
const matches = (res: RegExp[], path: string) => res.some((re) => re.test(path));

/** Whether a path matches any of the screen map's globs (`**`, `*`, `?`). */
export const videoGlobMatches = (globs: readonly string[], path: string): boolean =>
  matches(compile(globs), path);

/** `JourneyDesigner.tsx` -> `journey-designer`. */
export const kebabOfStem = (path: string): string => {
  const stem = (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
  return stem
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
};

const titleOfStem = (path: string): string => {
  const words = kebabOfStem(path).split('-').filter(Boolean);
  const t = words.join(' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const withCards = (path: string, cards?: Record<string, string[]>) => {
  const keys = cards?.[path] ?? [];
  return keys.length ? `${path} (${keys.join(', ')})` : path;
};

const summarise = (prefix: string, paths: string[], cards?: Record<string, string[]>): string => {
  const shown = paths.slice(0, REASON_PATHS).map((p) => withCards(p, cards));
  const more = paths.length - shown.length;
  return `${prefix}: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
};

/**
 * Which videos a release re-renders and which it creates. The rules are applied in order for each changed path (see
 * VIDEO_RULE_TEXT); the result is sorted by slug.
 */
export function mapChangesToVideos(input: VideoMappingInput): VideoMapping {
  const { map, cardsByPath } = input;
  const specs = new Set(input.specs);
  const ui = compile(map.ui);
  const pages = compile(map.pages);
  const shared = compile(map.shared);
  const exclude = compile(map.exclude);
  const screens = Object.entries(map.videos).map(([slug, v]) => ({
    slug,
    screens: v.screens.map((s) => ({ name: s.name, res: compile(s.files) })),
  }));
  const planned = Object.entries(map.planned).map(([slug, p]) => ({ slug, title: p.title, pages: p.pages }));

  const scripts = new Map<string, string[]>();
  const screenHits = new Map<string, Map<string, string[]>>();
  const fresh = new Map<string, NewVideo & { paths: string[] }>();
  const sharedOut: string[] = [];
  const unmapped: string[] = [];
  let ignoredCount = 0;
  const push = <K>(m: Map<K, string[]>, k: K, v: string) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };

  const paths = [...input.changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const c of paths) {
    const path = c.path;
    // 1. script changed
    const script = SCRIPT_RE.exec(path);
    if (script) {
      if (c.status !== 'D') push(scripts, (script[1] ?? script[2]) as string, path);
      continue;
    }
    // 2. shared UI
    if (matches(shared, path)) {
      sharedOut.push(path);
      continue;
    }
    // 3. screen changed
    let hit = false;
    for (const v of screens)
      for (const s of v.screens)
        if (matches(s.res, path)) {
          hit = true;
          let per = screenHits.get(v.slug);
          if (!per) {
            per = new Map();
            screenHits.set(v.slug, per);
          }
          push(per, s.name, path);
        }
    if (hit) continue;
    // 4. new screen
    if (matches(pages, path) && !matches(exclude, path)) {
      if (c.status === 'A' || c.status === 'M' || c.status === 'R') {
        const plan = planned.find((p) => p.pages.includes(path));
        const slug = plan?.slug ?? kebabOfStem(path);
        const title = plan?.title ?? titleOfStem(path);
        const nv = fresh.get(slug) ?? { slug, title, pages: [], reasons: [], paths: [] };
        nv.pages.push(path);
        nv.paths.push(path);
        fresh.set(slug, nv);
      }
      continue;
    }
    if (matches(exclude, path)) {
      ignoredCount++;
      continue;
    }
    // 5. unmapped UI
    if (matches(ui, path)) {
      unmapped.push(path);
      continue;
    }
    // 6. not UI
    ignoredCount++;
  }

  const slugs = new Set([...scripts.keys(), ...screenHits.keys()]);
  const selected: VideoSelection[] = [...slugs].sort().map((slug) => {
    const reasons: string[] = [];
    for (const p of scripts.get(slug) ?? []) reasons.push(`script changed: ${p}`);
    for (const [name, ps] of screenHits.get(slug) ?? [])
      reasons.push(summarise(`screen ${name} changed`, ps, cardsByPath));
    const missing = !specs.has(slug);
    if (missing) reasons.push('spec missing');
    return { slug, reasons, ...(missing ? { specMissing: true } : {}) };
  });
  const newVideos: NewVideo[] = [...fresh.values()]
    .filter((v) => !slugs.has(v.slug) && !specs.has(v.slug))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1))
    .map((v) => ({
      slug: v.slug,
      title: v.title,
      pages: v.pages,
      reasons: [summarise(`new screen ${v.title}`, v.paths, cardsByPath)],
    }));
  return { rule: VIDEO_RULE_TEXT, selected, newVideos, shared: sharedOut, unmapped, ignoredCount };
}

/** The voice of the existing videos (their sidecars), or why there is no single one. */
export type LibraryVoice = { ok: true; label: string | null } | { ok: false; error: string };

export function libraryVoiceLabel(sidecars: { voice?: unknown }[]): LibraryVoice {
  const labels = [...new Set(sidecars.map((s) => (typeof s.voice === 'string' ? s.voice : '(none)')))].sort();
  if (labels.length === 0) return { ok: true, label: null };
  if (labels.length > 1)
    return {
      ok: false,
      error: `voice unavailable: the existing videos use different voices (${labels.join(', ')})`,
    };
  return { ok: true, label: labels[0] as string };
}

export interface VoiceProbe {
  available: boolean;
  label: string;
}

/** The preflight rule: the voice must be installed and be exactly the voice of the existing videos. */
export function checkVideoVoice(
  probe: VoiceProbe,
  library: LibraryVoice,
  workstation: string,
): string | null {
  if (!library.ok) return library.error;
  if (!probe.available)
    return `voice unavailable: ${probe.label} is not installed on ${workstation} (run e2e/video/setup-voice.sh; ask DevOps)`;
  if (library.label && probe.label !== library.label)
    return `voice unavailable: the workstation's environment selects ${probe.label} (AOM_VIDEO_TTS/AOM_VIDEO_VOICE), the videos use ${library.label}`;
  return null;
}

export const VideoActionSchema = z.enum(['regenerate', 'create', 'up_to_date', 'reused']);
export const VideoStateSchema = z.enum(['rendered', 'failed', 'skipped', 'pending']);

export const VideoReportEntrySchema = z.object({
  slug: z.string(),
  title: z.string().optional(),
  action: VideoActionSchema,
  reasons: z.array(z.string()),
  state: VideoStateSchema,
  error: z.string().optional(),
  mb: z.object({ webm: z.number(), mp4: z.number() }).optional(),
  duration: z.number().optional(),
  files: z.array(z.string()).optional(),
});
export type VideoReportEntry = z.infer<typeof VideoReportEntrySchema>;

export const VideoStepReportSchema = z.object({
  harness: z.boolean(),
  rule: z.string().optional(),
  voice: z.string().nullable().optional(),
  base: z.string().optional(),
  head: z.string().optional(),
  videos: z.array(VideoReportEntrySchema).default([]),
  shared: z.array(z.string()).default([]),
  unmapped: z.array(z.string()).default([]),
  ignoredCount: z.number().default(0),
  needsAuthoring: z
    .array(
      z.object({
        slug: z.string(),
        title: z.string(),
        pages: z.array(z.string()),
        reasons: z.array(z.string()),
      }),
    )
    .optional(),
  /** How many shared or unmapped paths were cut from the lists. */
  more: z.object({ shared: z.number(), unmapped: z.number() }).optional(),
});
export type VideoStepReport = z.infer<typeof VideoStepReportSchema>;

const MAX_REASONS = 20;
const MAX_ERROR = 2000;
const MAX_LIST = 200;

/** Keeps a report well below the 64 KB the server stores per step. */
export function capVideoReport(r: VideoStepReport): VideoStepReport {
  const cut = (s?: string) => (s && s.length > MAX_ERROR ? `${s.slice(0, MAX_ERROR)}...` : s);
  return {
    ...r,
    videos: r.videos.map((v) => ({
      ...v,
      reasons: v.reasons.slice(0, MAX_REASONS),
      ...(v.error ? { error: cut(v.error) } : {}),
    })),
    shared: r.shared.slice(0, MAX_LIST),
    unmapped: r.unmapped.slice(0, MAX_LIST),
    ...(r.needsAuthoring
      ? { needsAuthoring: r.needsAuthoring.map((n) => ({ ...n, reasons: n.reasons.slice(0, MAX_REASONS) })) }
      : {}),
    more: {
      shared: Math.max(0, r.shared.length - MAX_LIST) + (r.more?.shared ?? 0),
      unmapped: Math.max(0, r.unmapped.length - MAX_LIST) + (r.more?.unmapped ?? 0),
    },
  };
}
