import { readFileSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  RENDER_HEARTBEAT_MS,
  RENDER_IDLE_POLL_MS,
  RENDER_WORKER_TOKEN_PREFIX,
  type RenderClaimResponse,
  RenderClaimResponseSchema,
  type RenderJobInput,
  RenderJobInputSchema,
  WORKER_VERSION_HEADER,
} from '@aom/shared';
import type { EncoderChoice, RenderEncoderUsed } from '@aom/video';
import { appVersion } from '../app-version.ts';
import { parseEncodeThreads } from '../config.ts';
import { type PushDeps, pushArtifacts, sha256File } from './push-client.ts';

/**
 * The remote render worker (`video-worker --remote`, core DESIGN R16, R19, R23). It runs on the GPU machine (the DevBox)
 * and talks to the server only through the render job API over HTTPS with its own token: claim, fetch the script, render,
 * upload the files to the signed links, complete. It never reads the database or the server's secret key, and refuses to
 * start when either is in its environment (that combination is the retired tunnel mode).
 *
 * Env: AOM_RENDER_SERVER_URL; AOM_RENDER_WORKER_TOKEN_FILE (preferred: read once at boot, so the token never shows in
 * `docker inspect`) or AOM_RENDER_WORKER_TOKEN; AOM_VIDEO_DIR (scratch); AOM_VIDEO_ENCODE_THREADS; AOM_VIDEO_GPU
 * (off | require | auto) and AOM_FFMPEG_GPU. A private CA comes in through NODE_EXTRA_CA_CERTS; TLS verification is
 * never switched off.
 */

export interface RemoteWorkerConfig {
  serverUrl: string;
  token: string;
  videoDir: string;
  encodeThreads: number | undefined;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The database-connected remote render mode is retired (R16): a worker with AOM_VIDEO_PUSH_URL does not start. */
export function refuseRetiredPushMode(env: Readonly<Record<string, string | undefined>> = process.env): void {
  if (env.AOM_VIDEO_PUSH_URL)
    throw new Error(
      'AOM_VIDEO_PUSH_URL is set: remote render workers use `video-worker --remote` with AOM_RENDER_SERVER_URL (and a worker token from Platform > Video > Render workers). Remove AOM_VIDEO_PUSH_URL.',
    );
}

/** Reads and checks the worker's environment. Throws with a message the operator can act on; never echoes the token. */
export function remoteWorkerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): RemoteWorkerConfig {
  for (const k of ['DATABASE_URL', 'AOM_SECRET_KEY'])
    if (env[k])
      throw new Error(
        `${k} is set: a remote render worker never connects to the database or holds the server key. Remove it (the old tunnel mode is retired).`,
      );
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new Error(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 is refused: TLS is always verified. For a private CA set NODE_EXTRA_CA_CERTS to its certificate.',
    );
  const raw = env.AOM_RENDER_SERVER_URL?.trim();
  if (!raw) throw new Error('AOM_RENDER_SERVER_URL is required (the server the worker claims renders from).');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('AOM_RENDER_SERVER_URL is not a valid URL.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
    throw new Error('AOM_RENDER_SERVER_URL must be https (plain http only to a loopback address).');
  let token: string | undefined;
  if (env.AOM_RENDER_WORKER_TOKEN_FILE) {
    try {
      token = readFile(env.AOM_RENDER_WORKER_TOKEN_FILE).trim();
    } catch (e) {
      throw new Error(
        `cannot read AOM_RENDER_WORKER_TOKEN_FILE ${env.AOM_RENDER_WORKER_TOKEN_FILE}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`,
      );
    }
  } else token = env.AOM_RENDER_WORKER_TOKEN?.trim();
  if (!token)
    throw new Error(
      'no worker token: set AOM_RENDER_WORKER_TOKEN_FILE (preferred) or AOM_RENDER_WORKER_TOKEN.',
    );
  if (!token.startsWith(RENDER_WORKER_TOKEN_PREFIX))
    throw new Error(
      `the worker token does not look like a render worker token (${RENDER_WORKER_TOKEN_PREFIX}...).`,
    );
  return {
    serverUrl: url.toString().replace(/\/+$/, ''),
    token,
    videoDir: env.AOM_VIDEO_DIR || '/data/video',
    encodeThreads: parseEncodeThreads(env.AOM_VIDEO_ENCODE_THREADS),
  };
}

/** What the worker's renderer returns (the subset it uses). */
export interface RemoteRenderResult {
  artifacts: Record<string, string | null>;
  durationSeconds: number;
  bytes: number;
  encoder?: RenderEncoderUsed;
}
export type RemoteRenderFn = (
  script: unknown,
  opts: {
    outDir: string;
    log: (l: string) => void;
    encodeThreads?: number;
    renderLabel?: string;
    gpu: { bin: string } | null;
    onGpuFailure: (reason: string) => void;
  },
) => Promise<RemoteRenderResult>;

export interface RemoteWorkerDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  render?: RemoteRenderFn;
  detect?: () => Promise<EncoderChoice>;
  log?: (line: string) => void;
  version?: string | null;
  push?: PushDeps;
  /** Heartbeat interval (tests shorten it). */
  heartbeatMs?: number;
}

const defaultRender: RemoteRenderFn = async (script, opts) => {
  const { renderScript } = await import('./renders.ts');
  const r = await renderScript(script, {
    outDir: opts.outDir,
    log: opts.log,
    encodeThreads: opts.encodeThreads,
    renderLabel: opts.renderLabel,
    gpu: opts.gpu,
    onGpuFailure: opts.onGpuFailure,
  });
  return {
    artifacts: { ...r.artifacts },
    durationSeconds: r.durationSeconds,
    bytes: r.bytes,
    encoder: r.encoder,
  };
};
const defaultDetect = async (): Promise<EncoderChoice> => (await import('@aom/video')).detectEncoder();

/** A JSON answer of the job API: a result (`status`, `error` text of a failed complete) or `{error: {code, message}}`. */
interface ApiBody {
  status?: string;
  error?: string | { code?: string; message?: string };
  [key: string]: unknown;
}
const errorOf = (b: ApiBody | null) => (b && typeof b.error === 'object' ? b.error : undefined);

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

export type TickOutcome = 'idle' | 'rendered' | 'failed' | 'lost' | 'backoff' | 'outdated' | 'refused';

const MAX_BACKOFF_MS = 5 * 60_000;

export class RemoteWorker {
  private encoder: EncoderChoice = { encoder: 'cpu', reason: 'not detected yet', bin: null };
  private backoff = 0;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly version: string | null;

  constructor(
    private readonly cfg: RemoteWorkerConfig,
    private readonly deps: RemoteWorkerDeps = {},
  ) {
    this.fetch = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.log = deps.log ?? ((l) => console.log(l));
    this.version = deps.version !== undefined ? deps.version : appVersion();
  }

  get currentEncoder(): EncoderChoice {
    return this.encoder;
  }

  /** Detects the encoder once (R19) and logs it; `AOM_VIDEO_GPU=require` makes this throw (the worker exits). */
  async start(): Promise<EncoderChoice> {
    this.encoder = await (this.deps.detect ?? defaultDetect)();
    // render-worker.sh `status` reads this line: it names `encoder` and `nvenc` or `cpu`
    this.log(
      this.encoder.encoder === 'nvenc'
        ? `render worker: encoder nvenc (h264_nvenc test encode passed, ${this.encoder.bin})`
        : `render worker: encoder cpu (${this.encoder.reason})`,
    );
    this.log(`render worker ${this.version ?? '(no version)'} claims renders from ${this.cfg.serverUrl}`);
    return this.encoder;
  }

  /**
   * A server-relative link resolved against AOM_RENDER_SERVER_URL. Anything that resolves to another origin (for
   * example `//other.host/...`) is refused, so the bearer token never goes anywhere else.
   */
  resolve(path: string): string {
    const base = new URL(`${this.cfg.serverUrl}/`);
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new Error('the server sent a link to another origin; refused');
    return url.toString();
  }

  private headers(json = true): Record<string, string> {
    return {
      authorization: `Bearer ${this.cfg.token}`,
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(this.version ? { [WORKER_VERSION_HEADER]: this.version } : {}),
    };
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: ApiBody | null }> {
    const res = await this.fetch(this.resolve(path), {
      method,
      headers: this.headers(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text().catch(() => '');
    let json: ApiBody | null = null;
    try {
      json = text ? (JSON.parse(text) as ApiBody) : null;
    } catch {
      json = null;
    }
    if (res.status >= 400)
      throw new HttpFailure(
        res.status,
        errorOf(json)?.code ?? null,
        `${method} ${path.split('?')[0]} -> HTTP ${res.status} ${errorOf(json)?.message ?? text.slice(0, 200)}`,
      );
    return { status: res.status, json };
  }

  private encoderBody() {
    return {
      encoder: this.encoder.encoder,
      encoderReason: this.encoder.encoder === 'cpu' ? this.encoder.reason : null,
    };
  }

  /** The wait after a 429, a 5xx or a network error: 15 s doubling to 5 min, reset by the next good answer. */
  private nextBackoff(): number {
    this.backoff = this.backoff ? Math.min(this.backoff * 2, MAX_BACKOFF_MS) : RENDER_IDLE_POLL_MS;
    return this.backoff;
  }

  /** One claim and, if there is a job, its whole render. Returns what happened and how long to wait before the next. */
  async tick(): Promise<{ outcome: TickOutcome; waitMs: number }> {
    let job: RenderClaimResponse;
    try {
      const r = await this.call('POST', '/api/render/jobs/claim', {
        version: this.version,
        ...this.encoderBody(),
      });
      this.backoff = 0;
      if (r.status === 204 || !r.json) return { outcome: 'idle', waitMs: RENDER_IDLE_POLL_MS };
      job = RenderClaimResponseSchema.parse(r.json);
    } catch (err) {
      if (err instanceof HttpFailure && err.code === 'worker_outdated') {
        this.log(`render worker: ${err.message}`);
        return { outcome: 'outdated', waitMs: RENDER_IDLE_POLL_MS * 4 };
      }
      if (err instanceof HttpFailure && err.status === 401) {
        this.log(
          'render worker: the server refused the worker token (revoked or unknown); add a new worker on Platform > Video',
        );
        return { outcome: 'refused', waitMs: MAX_BACKOFF_MS };
      }
      this.log(`render worker: claim failed: ${(err as Error).message}`);
      return { outcome: 'backoff', waitMs: this.nextBackoff() };
    }
    return { outcome: await this.runJob(job), waitMs: 0 };
  }

  private async runJob(job: RenderClaimResponse): Promise<TickOutcome> {
    const outDir = join(this.cfg.videoDir, job.renderId);
    let lost = false;
    const heartbeat = async () => {
      try {
        await this.call('POST', `/api/render/jobs/${job.renderId}/heartbeat`, {
          attempt: job.attempt,
          ...this.encoderBody(),
        });
      } catch (err) {
        if (err instanceof HttpFailure && err.status === 409) lost = true;
        this.log(`render worker: heartbeat: ${(err as Error).message}`);
      }
    };
    const beat = setInterval(() => void heartbeat(), this.deps.heartbeatMs ?? RENDER_HEARTBEAT_MS);
    try {
      this.log(`render worker: claimed render ${job.renderId} (attempt ${job.attempt})`);
      const input: RenderJobInput = RenderJobInputSchema.parse((await this.call('GET', job.inputUrl)).json);
      await rm(outDir, { recursive: true, force: true });
      await mkdir(outDir, { recursive: true });
      const out = await (this.deps.render ?? defaultRender)(input.script, {
        outDir,
        log: (l) => this.log(`video render: ${l}`),
        ...(this.cfg.encodeThreads ? { encodeThreads: this.cfg.encodeThreads } : {}),
        renderLabel: input.options.label,
        gpu: this.encoder.encoder === 'nvenc' && this.encoder.bin ? { bin: this.encoder.bin } : null,
        // a GPU problem never fails a render: the renderer retried on the CPU; the worker stays on the CPU until restart
        onGpuFailure: (reason) => {
          this.encoder = { encoder: 'cpu', reason: `NVENC failed during a render: ${reason}`, bin: null };
          this.log(`render worker: encoder cpu (${this.encoder.reason})`);
        },
      });
      if (lost) {
        this.log(
          `render worker: render ${job.renderId} attempt ${job.attempt} lost its lease; nothing is uploaded`,
        );
        return 'lost';
      }
      const files = Object.values(out.artifacts).filter(
        (f): f is string => !!f && !!job.uploadUrls[basename(f)],
      );
      await pushArtifacts(
        {
          token: this.cfg.token,
          version: this.version,
          urlOf: (name) => this.resolve(job.uploadUrls[name] as string),
        },
        files,
        this.deps.push,
      );
      const artifacts: Record<string, { sha256: string; size: number }> = {};
      for (const f of files)
        artifacts[basename(f)] = { sha256: await sha256File(f), size: (await stat(f)).size };
      const done = await this.call('POST', `/api/render/jobs/${job.renderId}/complete`, {
        attempt: job.attempt,
        bytes: out.bytes,
        artifacts,
        ...(out.encoder ? { encoder: out.encoder } : {}),
        ...(out.encoder === 'cpu_fallback' ? { encoderReason: this.encoder.reason } : {}),
      });
      this.log(
        `render worker: render ${job.renderId} ${done.json?.status ?? 'done'}${done.json?.error ? `: ${done.json.error}` : ''}`,
      );
      return done.json?.status === 'failed' ? 'failed' : 'rendered';
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 480);
      this.log(`render worker: render ${job.renderId} failed: ${message}`);
      if (err instanceof HttpFailure && err.status === 409) return 'lost';
      await this.call('POST', `/api/render/jobs/${job.renderId}/fail`, {
        attempt: job.attempt,
        message,
      }).catch((e) => this.log(`render worker: reporting the failure failed: ${(e as Error).message}`));
      return 'failed';
    } finally {
      clearInterval(beat);
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** The loop: claim, render, repeat; idle polls every 15 s with backoff on 429 and 5xx. Stops when `stopping()` says so. */
  async loop(stopping: () => boolean): Promise<void> {
    while (!stopping()) {
      const { waitMs } = await this.tick();
      if (waitMs > 0 && !stopping()) await this.sleep(waitMs);
    }
  }
}

/** `video-worker --remote`: read the config (refusing the old mode), detect the encoder, and loop until a signal. */
export async function runRemoteWorker(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const cfg = remoteWorkerConfig(env);
  const worker = new RemoteWorker(cfg);
  await worker.start();
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stopping = true));
  await worker.loop(() => stopping);
}
