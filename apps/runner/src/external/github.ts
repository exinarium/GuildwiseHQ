import {
  type AdapterCallContext,
  type ApprovedDraft,
  type ExternalAdapter,
  type ExternalRef,
  type ExternalSource,
  ExternalSourceSchema,
  type PostResult,
  parseGithubKey,
} from '@aom/shared';
import { execa } from 'execa';
import { redactSecrets } from '../secrets/redact.ts';
import { AppCredentialError, type AppTokenSource, ghEnvFor } from './app-token.ts';

/** Runs a command and returns its output; a seam so tests never start `gh` (and never reach GitHub). */
export type Exec = (
  bin: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const defaultExec: Exec = async (bin, args, opts) => {
  const r = await execa(bin, args, {
    reject: false,
    stdin: 'ignore',
    timeout: 60_000,
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    // Added to the runner's own environment (execa's extendEnv); never logged.
    ...(opts?.env ? { env: opts.env } : {}),
  });
  if ((r as { code?: string }).code === 'ENOENT')
    throw Object.assign(new Error(`${bin} not found`), { code: 'ENOENT' });
  return { exitCode: r.exitCode ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
};

/** A post the system refused (a non-zero exit, a non-2xx answer): definitely not posted, safe to try again. */
export class PostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostError';
  }
}

export class SourceReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceReadError';
  }
}

interface GhIssue {
  title?: string;
  body?: string;
  state?: string;
  url?: string;
  labels?: Array<{ name?: string }>;
  comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string }>;
}

/** `gh` output for an error message, with any token redacted. */
function ghOutput(r: { exitCode: number; stdout: string; stderr: string }): string {
  return redactSecrets((r.stderr || r.stdout).trim()).slice(0, 500) || `exit ${r.exitCode}`;
}

/**
 * Runs `gh` as the project's GitHub App when one is selected and covers `repo` (`GH_TOKEN` in the child environment),
 * else exactly as before with the workstation's `gh` login. A selected app that cannot get a token throws `wrap(message)`
 * before `gh` starts.
 */
export async function runGh(
  o: { bin?: string | undefined; exec?: Exec | undefined; appTokens?: AppTokenSource | undefined },
  args: string[],
  repo: string,
  ctx: AdapterCallContext | undefined,
  wrap: (message: string) => Error,
): Promise<Awaited<ReturnType<Exec>>> {
  let env: Record<string, string> | undefined;
  try {
    env = await ghEnvFor(o.appTokens, ctx?.app, repo);
  } catch (err) {
    if (err instanceof AppCredentialError) throw wrap(err.message);
    throw err;
  }
  const exec = o.exec ?? defaultExec;
  const bin = o.bin ?? 'gh';
  try {
    // No app: exactly the two-argument call of before.
    return env ? await exec(bin, args, { env }) : await exec(bin, args);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT')
      throw wrap('the GitHub CLI (`gh`) is not installed on this workstation');
    throw err;
  }
}

/**
 * GitHub issues through `gh issue view --json` on this workstation (docs/ARCHITECTURE.md section 16.5): the credentials
 * are the user's own `gh` login, or the installation token of the project's selected GitHub App when the server sends
 * one (`ctx.app`); nothing goes through the site. `postApproved` comments with `gh issue comment`, or
 * (for a resolution) closes the issue with the text as its closing comment, `gh issue close --comment`.
 */
export class GithubAdapter implements ExternalAdapter {
  readonly system = 'github' as const;

  constructor(private readonly opts: { bin?: string; exec?: Exec; appTokens?: AppTokenSource } = {}) {}

  async readSource(ref: ExternalRef, ctx?: AdapterCallContext): Promise<ExternalSource> {
    const gh = parseGithubKey(ref.key);
    if (!gh)
      throw new SourceReadError(`'${ref.key}' is not a GitHub issue reference (expected owner/repo#12)`);
    const r = await runGh(
      this.opts,
      [
        'issue',
        'view',
        String(gh.number),
        '--repo',
        gh.repo,
        '--json',
        'title,body,state,url,labels,comments',
      ],
      gh.repo,
      ctx,
      (m) => new SourceReadError(m),
    );
    if (r.exitCode !== 0) throw new SourceReadError(`gh issue view failed: ${ghOutput(r)}`);
    let issue: GhIssue;
    try {
      issue = JSON.parse(r.stdout) as GhIssue;
    } catch {
      throw new SourceReadError('gh returned something that is not JSON');
    }
    return ExternalSourceSchema.parse({
      ref,
      title: issue.title ?? '',
      body: issue.body ?? '',
      ...(issue.state ? { status: issue.state } : {}),
      labels: (issue.labels ?? []).flatMap((l) => (l.name ? [l.name] : [])),
      ...(issue.url ? { url: issue.url } : {}),
      comments: (issue.comments ?? []).map((c) => ({
        ...(c.author?.login ? { author: c.author.login } : {}),
        body: c.body ?? '',
        ...(c.createdAt ? { at: c.createdAt } : {}),
      })),
    });
  }

  private run(args: string[], repo: string, ctx?: AdapterCallContext): Promise<Awaited<ReturnType<Exec>>> {
    return runGh(this.opts, args, repo, ctx, (m) => new PostError(m));
  }

  async postApproved(draft: ApprovedDraft, ctx?: AdapterCallContext): Promise<PostResult> {
    const gh = parseGithubKey(draft.ref.key);
    if (!gh)
      throw new PostError(`'${draft.ref.key}' is not a GitHub issue reference (expected owner/repo#12)`);
    const n = String(gh.number);
    const args =
      draft.kind === 'resolution'
        ? ['issue', 'close', n, '--repo', gh.repo, '--comment', draft.body]
        : ['issue', 'comment', n, '--repo', gh.repo, '--body', draft.body];
    const r = await this.run(args, gh.repo, ctx);
    if (r.exitCode !== 0) throw new PostError(`gh issue ${args[1]} failed: ${ghOutput(r)}`);
    const url = /https?:\/\/\S+/.exec(`${r.stdout}\n${r.stderr}`)?.[0];
    return { externalRef: url ?? draft.ref.url ?? `https://github.com/${gh.repo}/issues/${gh.number}` };
  }

  /**
   * Is a comment with exactly this text already on the issue? (A retry after an ambiguous failure.) Any author counts,
   * so a text posted by the personal login before the project switched to an app (or the other way round) is found.
   */
  async findPosted(draft: ApprovedDraft, ctx?: AdapterCallContext): Promise<PostResult | null> {
    const gh = parseGithubKey(draft.ref.key);
    if (!gh) return null;
    const r = await this.run(
      ['issue', 'view', String(gh.number), '--repo', gh.repo, '--json', 'comments,url'],
      gh.repo,
      ctx,
    );
    if (r.exitCode !== 0) return null;
    try {
      const issue = JSON.parse(r.stdout) as {
        url?: string;
        comments?: Array<{ body?: string; url?: string }>;
      };
      const hit = (issue.comments ?? []).find((c) => (c.body ?? '').trim() === draft.body.trim());
      return hit ? { externalRef: hit.url ?? issue.url ?? draft.ref.url ?? draft.ref.key } : null;
    } catch {
      return null;
    }
  }
}
