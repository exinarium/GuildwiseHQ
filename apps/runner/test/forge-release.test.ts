import { describe, expect, it } from 'vitest';
import {
  AzureDevOpsForge,
  BitbucketCloudForge,
  GitHubForge,
  GitLabForge,
  MemoryTokenStore,
  PlainGitForge,
} from '../src/forge/index.ts';
import type { ForgeEnv, RemoteRepo } from '../src/forge/types.ts';
import type { ExecOptions, ExecResult, Executor } from '../src/toolchain/exec.ts';

class Exec implements Executor {
  calls: Array<{ line: string; input?: string | undefined }> = [];
  constructor(private readonly rules: Array<[RegExp, Partial<ExecResult>]>) {}
  async run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    const line = [cmd, ...args].join(' ');
    this.calls.push({ line, input: opts?.input });
    for (const [re, r] of this.rules) if (re.test(line)) return { exitCode: 0, stdout: '', stderr: '', ...r };
    return { exitCode: 127, stdout: '', stderr: 'not found' };
  }
}

const repo: RemoteRepo = {
  kind: 'github',
  host: 'github.com',
  fullName: 'o/r',
  url: 'https://github.com/o/r.git',
};
const input = {
  tag: 'v1.4.0',
  title: 'Guildwise HQ 1.4.0',
  notes: '### Added\n\n- One.',
  latest: true,
  prerelease: false,
};

const env = (exec: Executor, over: Partial<ForgeEnv> = {}): ForgeEnv => ({
  exec,
  fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
  tokens: new MemoryTokenStore(),
  processEnv: {},
  ...over,
});

describe('GitHub releases through gh', () => {
  it('creates the release for a verified tag with the section as notes on stdin, marked latest', async () => {
    const exec = new Exec([
      [/^gh release view/, { exitCode: 1, stderr: 'release not found' }],
      [/^gh release create/, { stdout: 'https://github.com/o/r/releases/tag/v1.4.0\n' }],
    ]);
    const gh = new GitHubForge(env(exec));
    expect(gh.caps.releases).toBe(true);
    expect(await gh.findRelease?.(repo, 'v1.4.0')).toBeNull();
    const made = await gh.createRelease?.(repo, input);
    expect(made?.url).toBe('https://github.com/o/r/releases/tag/v1.4.0');
    const create = exec.calls.find((c) => c.line.startsWith('gh release create'));
    expect(create?.line).toBe(
      'gh release create v1.4.0 --repo o/r --verify-tag --title Guildwise HQ 1.4.0 --notes-file - --latest',
    );
    expect(create?.input).toBe('### Added\n\n- One.');
  });

  it('does not mark a hotfix latest, and flags a pre-release', async () => {
    const exec = new Exec([
      [/^gh release create/, { stdout: 'https://github.com/o/r/releases/tag/v1.3.1\n' }],
    ]);
    await new GitHubForge(env(exec)).createRelease?.(repo, { ...input, latest: false, prerelease: true });
    expect(exec.calls[0]?.line).toContain('--latest=false --prerelease');
  });

  it('finds an existing release, and reads it again when create says it exists (never edits)', async () => {
    const exec = new Exec([
      [/^gh release view/, { stdout: JSON.stringify({ url: 'https://github.com/o/r/releases/tag/v1.4.0' }) }],
    ]);
    const gh = new GitHubForge(env(exec));
    expect((await gh.findRelease?.(repo, 'v1.4.0'))?.url).toContain('/releases/tag/v1.4.0');
    const racing = new Exec([
      [/^gh release create/, { exitCode: 1, stderr: 'a release with the same tag name already exists' }],
      [/^gh release view/, { stdout: JSON.stringify({ url: 'https://github.com/o/r/releases/tag/v1.4.0' }) }],
    ]);
    const made = await new GitHubForge(env(racing)).createRelease?.(repo, input);
    expect(made?.url).toContain('v1.4.0');
    expect(racing.calls.some((c) => /release (edit|delete)/.test(c.line))).toBe(false);
  });

  it('surfaces the message of a failed create', async () => {
    const exec = new Exec([
      [/^gh release create/, { exitCode: 1, stderr: 'tag v1.4.0 not found on the remote' }],
    ]);
    await expect(new GitHubForge(env(exec)).createRelease?.(repo, input)).rejects.toThrow(
      'gh release create failed: tag v1.4.0 not found on the remote',
    );
  });

  it('reads the merge commit of a merged pull request', async () => {
    const sha = 'c'.repeat(40);
    const exec = new Exec([[/^gh pr view 7/, { stdout: `${sha}\n` }]]);
    expect(await new GitHubForge(env(exec)).changeMergeCommit?.(repo, '7')).toBe(sha);
  });
});

describe('GitLab releases through the Releases API', () => {
  const glRepo: RemoteRepo = {
    kind: 'gitlab',
    host: 'gitlab.com',
    fullName: 'g/r',
    url: 'https://gitlab.com/g/r.git',
  };
  const tokens = () => {
    const t = new MemoryTokenStore();
    t.set({ provider: 'gitlab', host: 'gitlab.com', token: 'glpat-SECRET' });
    return t;
  };
  const fetcher = (
    status: (m: string) => number,
    calls: Array<{ method: string; url: string; body: unknown }>,
  ) =>
    (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const s = status(method);
      return new Response(
        JSON.stringify(
          s < 300 ? { _links: { self: 'https://gitlab.com/g/r/-/releases/v1.4.0' } } : { message: 'x' },
        ),
        {
          status: s,
        },
      );
    }) as unknown as typeof fetch;

  it('posts tag, name and description', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const gl = new GitLabForge(env(new Exec([]), { fetch: fetcher(() => 201, calls), tokens: tokens() }));
    expect(gl.caps.releases).toBe(true);
    const made = await gl.createRelease?.(glRepo, input);
    expect(made?.url).toBe('https://gitlab.com/g/r/-/releases/v1.4.0');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://gitlab.com/api/v4/projects/g%2Fr/releases',
      body: { tag_name: 'v1.4.0', name: 'Guildwise HQ 1.4.0', description: '### Added\n\n- One.' },
    });
  });

  it('reads the release again on a 409 and reports a missing one as null', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const gl = new GitLabForge(
      env(new Exec([]), { fetch: fetcher((m) => (m === 'POST' ? 409 : 200), calls), tokens: tokens() }),
    );
    expect((await gl.createRelease?.(glRepo, input))?.url).toContain('/releases/v1.4.0');
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET']);
    const none = new GitLabForge(env(new Exec([]), { fetch: fetcher(() => 404, []), tokens: tokens() }));
    expect(await none.findRelease?.(glRepo, 'v1.4.0')).toBeNull();
  });
});

describe('forges without release pages', () => {
  it('have no release capability', () => {
    const e = env(new Exec([]));
    expect(new PlainGitForge(e, 'git.example.test').caps.releases).toBe(false);
    expect(new AzureDevOpsForge(e, 'dev.azure.com', 'acme').caps.releases).toBe(false);
    expect(new BitbucketCloudForge(e).caps.releases).toBe(false);
    expect(
      (new PlainGitForge(e, 'git.example.test') as { createRelease?: unknown }).createRelease,
    ).toBeUndefined();
  });
});
