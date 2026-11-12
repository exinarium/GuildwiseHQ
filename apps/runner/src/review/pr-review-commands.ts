import { readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  PrReviewPostPayload,
  PrReviewPostResult,
  PrReviewRunPayload,
  PrReviewRunResult,
} from '@aom/shared';
import type { SandboxState } from '../adapters/claude-policy.ts';
import type { RuntimeAdapter } from '../adapters/types.ts';
import { ForgeUnavailableError } from '../forge/http.ts';
import { forgeForUrl } from '../forge/index.ts';
import type { ForgeEnv } from '../forge/types.ts';
import type { GitAuth } from '../git/worktrees.ts';
import type { RunnerPaths } from '../paths.ts';
import { wipeAgent } from '../sandbox/sandbox.ts';
import { postPrReview } from './post.ts';
import { GitHubReviewPoster } from './review-poster.ts';
import { disposeReviewerRun, prepareReviewerRun } from './reviewer-sandbox.ts';
import type { ReviewerTokenStore } from './reviewer-tokens.ts';
import { runPrReview } from './run.ts';

export interface PrReviewCommandsEnv {
  paths: RunnerPaths;
  adapters: Map<string, RuntimeAdapter>;
  tokens: ReviewerTokenStore;
  forgeEnv: ForgeEnv;
  /** The owner's clone of a repository by normalized remote url. */
  findRepo: (remoteUrlNormalized: string) => Promise<{ localPath: string; remoteUrl: string } | undefined>;
  /** The clone's own git login (never given to the reviewer). */
  gitAuth: GitAuth;
  /** The OS-sandbox state of the adapter that runs the model. */
  sandboxState: (adapter: RuntimeAdapter) => SandboxState;
  fetch: typeof fetch;
  log: (line: string) => void;
}

/**
 * `pr_review.run` and `pr_review.post` on this workstation. Each is answered once per run id while it is live: a command
 * the server sent again after a reconnect awaits the same promise (so one run never starts two model sessions and one
 * run never posts twice).
 */
export class PrReviewCommands {
  private readonly runs = new Map<string, Promise<PrReviewRunResult>>();
  private readonly posts = new Map<string, Promise<PrReviewPostResult>>();

  constructor(private readonly env: PrReviewCommandsEnv) {}

  /** Run ids with a live `pr_review.run`: the startup sweep keeps their folders. */
  liveRunIds(): string[] {
    return [...this.runs.keys()];
  }

  run(payload: PrReviewRunPayload): Promise<PrReviewRunResult> {
    const live = this.runs.get(payload.runId);
    if (live) return live;
    const p = this.start(payload).finally(() => this.runs.delete(payload.runId));
    this.runs.set(payload.runId, p);
    return p;
  }

  post(payload: PrReviewPostPayload): Promise<PrReviewPostResult> {
    const live = this.posts.get(payload.runId);
    if (live) return live;
    const p = postPrReview(
      { poster: new GitHubReviewPoster({ fetch: this.env.fetch, tokens: this.env.tokens }) },
      payload,
    ).finally(() => this.posts.delete(payload.runId));
    this.posts.set(payload.runId, p);
    return p;
  }

  private async start(payload: PrReviewRunPayload): Promise<PrReviewRunResult> {
    const e = this.env;
    const adapter = e.adapters.get(payload.runtime);
    if (!adapter)
      return {
        outcome: 'failed',
        durationMs: 0,
        code: 'runtime_unavailable',
        error: `${payload.runtime} is not set up on this workstation`,
        retryable: true,
      };
    return runPrReview(
      {
        adapter,
        paths: e.paths,
        log: e.log,
        heads: async (p) => {
          const repo = await e.findRepo(p.remoteUrlNormalized);
          if (!repo) throw new Error('this workstation has no clone of the repository');
          this.clones.set(p.remoteUrlNormalized, repo.localPath);
          const hit = forgeForUrl(e.forgeEnv, repo.remoteUrl);
          if (!hit?.forge.changeHeads) throw new Error('this git host cannot be reviewed yet');
          try {
            return await hit.forge.changeHeads(hit.repo, String(p.prNumber));
          } catch (err) {
            if (err instanceof ForgeUnavailableError) throw new Error(`not signed in to the git host: ${err.message}`);
            throw err;
          }
        },
        prepare: (spec, ctx) =>
          prepareReviewerRun(
            {
              paths: e.paths,
              tokens: e.tokens,
              findRepo: (n) => this.cloneOf(n),
              sandboxState: e.sandboxState(adapter),
              configDir: ctx.configDir,
              agentId: ctx.agentId,
              auth: e.gitAuth,
            },
            spec,
          ),
        dispose: disposeReviewerRun,
      },
      payload,
    );
  }

  /** `prepareReviewerRun` asks for the clone synchronously: `heads` found it just before. */
  private readonly clones = new Map<string, string>();
  private cloneOf(normalized: string): string | undefined {
    return this.clones.get(normalized);
  }
}

/** Removes `agents/pr-review-<runId>` folders no live run owns (a crash left them). Returns how many it removed. */
export async function sweepPrReviewAgents(paths: RunnerPaths, liveRunIds: Iterable<string> = []): Promise<number> {
  const keep = new Set([...liveRunIds].map((id) => `pr-review-${id}`));
  const root = dirname(paths.agentDir('pr-review-x'));
  let removed = 0;
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!name.startsWith('pr-review-') || keep.has(name)) continue;
    await wipeAgent(paths, name).catch(() => undefined);
    removed++;
  }
  return removed;
}
