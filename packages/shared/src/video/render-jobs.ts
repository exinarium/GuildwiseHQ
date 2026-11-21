import { z } from 'zod';

/**
 * The render job API (core DESIGN R16, R19, R23): a remote render worker on a GPU machine claims renders over HTTPS with
 * its own revocable token and never touches the database. Routes: `apps/server/src/routes/render-jobs.ts`; the worker:
 * `apps/server/src/video/remote-worker.ts` (`video-worker --remote`).
 */

/** Every render worker token starts with this prefix (only its sha256 is stored). */
export const RENDER_WORKER_TOKEN_PREFIX = 'aomv_';
/** A remote claim holds the render this long; every heartbeat extends it by the same amount. */
export const RENDER_JOB_LEASE_MS = 10 * 60_000;
/** Signed input links are valid this long. */
export const RENDER_INPUT_URL_TTL_MS = 15 * 60_000;
/** Signed upload links are valid this long. */
export const RENDER_UPLOAD_URL_TTL_MS = 60 * 60_000;
/** The worker heartbeats this often while it renders. */
export const RENDER_HEARTBEAT_MS = 60_000;
/** The worker polls this often while there is nothing to do. */
export const RENDER_IDLE_POLL_MS = 15_000;

/** What a worker can encode with: NVENC on the GPU, or libx264 on the CPU. */
export const RENDER_WORKER_ENCODERS = ['nvenc', 'cpu'] as const;
export type RenderEncoder = (typeof RENDER_WORKER_ENCODERS)[number];
/** What a render used: `cpu_fallback` = NVENC failed during that render and it finished on the CPU. */
export const RENDER_USED_ENCODERS = ['nvenc', 'cpu', 'cpu_fallback'] as const;
export type RenderUsedEncoder = (typeof RENDER_USED_ENCODERS)[number];

/** The longest encoder reason stored and shown. */
const Reason = z.string().max(480);

export const RenderClaimRequestSchema = z.object({
  /** The worker's application version (the server refuses a worker older than itself: 409 worker_outdated). */
  version: z.string().max(60).nullable(),
  encoder: z.enum(RENDER_WORKER_ENCODERS),
  /** Why the worker is on the CPU (empty or absent on nvenc). */
  encoderReason: Reason.nullable().optional(),
});
export type RenderClaimRequest = z.infer<typeof RenderClaimRequestSchema>;

/** The artifact names a render may upload, in the order the worker sends them (the video last). */
export const RENDER_ARTIFACT_NAMES = [
  'captions.vtt',
  'captions.srt',
  'thumb.png',
  'script.json',
  'description.txt',
  'render.log',
  'video.mp4',
  'short.mp4',
] as const;

export const RenderClaimResponseSchema = z.object({
  renderId: z.uuid(),
  attempt: z.number().int().min(1),
  leaseUntil: z.iso.datetime(),
  /** Server-relative signed link (path and query) to the script and render options; needs the bearer token too. */
  inputUrl: z.string().startsWith('/'),
  /** Server-relative signed upload link per artifact name. */
  uploadUrls: z.record(z.string(), z.string().startsWith('/')),
});
export type RenderClaimResponse = z.infer<typeof RenderClaimResponseSchema>;

/** What `GET <inputUrl>` returns: the script and the render options, nothing else. */
export const RenderJobInputSchema = z.object({
  renderId: z.uuid(),
  attempt: z.number().int().min(1),
  /** The video script (validated again by the worker's renderer). */
  script: z.unknown(),
  options: z.object({
    label: z.string().max(200),
    coverName: z.string().max(120).nullable().optional(),
  }),
});
export type RenderJobInput = z.infer<typeof RenderJobInputSchema>;

export const RenderHeartbeatRequestSchema = z.object({
  attempt: z.number().int().min(1),
  encoder: z.enum(RENDER_WORKER_ENCODERS).optional(),
  encoderReason: Reason.nullable().optional(),
});
export type RenderHeartbeatRequest = z.infer<typeof RenderHeartbeatRequestSchema>;

export const RenderCompleteRequestSchema = z.object({
  attempt: z.number().int().min(1),
  bytes: z.number().int().min(0),
  artifacts: z.record(
    z.string(),
    z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().min(0) }),
  ),
  /** What this render used (`cpu_fallback` when NVENC failed during it). */
  encoder: z.enum(RENDER_USED_ENCODERS).optional(),
  /** Why NVENC failed, with `cpu_fallback`. */
  encoderReason: Reason.nullable().optional(),
});
export type RenderCompleteRequest = z.infer<typeof RenderCompleteRequestSchema>;

export const RenderFailRequestSchema = z.object({
  attempt: z.number().int().min(1),
  message: z.string().max(480),
});
export type RenderFailRequest = z.infer<typeof RenderFailRequestSchema>;

/** One render worker as the Render workers card and the video status show it. */
export const RenderWorkerSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
  lastIp: z.string().nullable(),
  version: z.string().nullable(),
  encoder: z.enum(RENDER_WORKER_ENCODERS).nullable(),
  encoderReason: z.string().nullable(),
  /** A warning badge: the worker renders on the CPU (no NVENC, or it fell back at run time). */
  warning: z.boolean(),
});
export type RenderWorker = z.infer<typeof RenderWorkerSchema>;

export const RenderWorkerListSchema = z.object({ workers: z.array(RenderWorkerSchema) });
export type RenderWorkerList = z.infer<typeof RenderWorkerListSchema>;

export const AddRenderWorkerRequestSchema = z.object({ name: z.string().trim().min(1).max(80) });
export type AddRenderWorkerRequest = z.infer<typeof AddRenderWorkerRequestSchema>;

/** The answer to adding a worker: the token, shown once and never again. */
export const AddRenderWorkerResponseSchema = z.object({ worker: RenderWorkerSchema, token: z.string() });
export type AddRenderWorkerResponse = z.infer<typeof AddRenderWorkerResponseSchema>;

/** The health entry of a render worker in the video status (`renderWorkers`). */
export const RenderWorkerHealthSchema = z.object({
  name: z.string(),
  encoder: z.enum(RENDER_WORKER_ENCODERS).nullable(),
  reason: z.string().nullable(),
  lastSeen: z.iso.datetime().nullable(),
  warning: z.boolean(),
});
export type RenderWorkerHealth = z.infer<typeof RenderWorkerHealthSchema>;
