import { describe, expect, it } from 'vitest';
import { GitHubForge, MemoryTokenStore } from '../src/forge/index.ts';
import type { ForgeEnv, RemoteRepo } from '../src/forge/types.ts';
import type { ExecOptions, ExecResult, Executor } from '../src/toolchain/exec.ts';

class FakeExec implements Executor {
  calls: string[] = [];
  constructor(private readonly stdout: string) {}
  async run(cmd: string, args: string[], _opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push([cmd, ...args].join(' '));
    return { exitCode: 0, stdout: this.stdout, stderr: '' };
  }
}
const env = (exec: Executor): ForgeEnv => ({
  exec,
  fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
  tokens: new MemoryTokenStore(),
  now: () => new Date('2026-11-12T08:00:00Z'),
  processEnv: {},
});
const repo: RemoteRepo = {
  kind: 'github',
  host: 'github.com',
  fullName: 'acme/web',
  url: 'https://github.com/acme/web.git',
};
const row = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  url: `https://github.com/acme/web/pull/${n}`,
  title: `Change ${n}`,
  author: { login: 'octo' },
  headRefName: `feature/${n}`,
  baseRefName: 'main',
  createdAt: '2026-11-12T07:00:00Z',
  ...extra,
});

describe('the list of open pull requests carries what the size check needs', () => {
  it('asks for changedFiles, isCrossRepository and headRefOid and maps them', async () => {
    const sha = 'c'.repeat(40);
    const x = new FakeExec(
      JSON.stringify([
        row(1, { additions: 30, deletions: 12, changedFiles: 4, isCrossRepository: true, headRefOid: sha }),
      ]),
    );
    const out = await new GitHubForge(env(x)).listOpenChanges(repo, 5);
    expect(x.calls[0]).toMatch(/changedFiles,isCrossRepository,headRefOid/);
    expect(out.changes[0]).toMatchObject({
      changedLines: 42,
      changedFiles: 4,
      crossRepo: true,
      headSha: sha,
    });
  });
  it('leaves a missing or malformed value out (the size is then unknown, not an error)', async () => {
    const x = new FakeExec(
      JSON.stringify([row(2), row(3, { changedFiles: 'x', isCrossRepository: 'no', headRefOid: 'abc' })]),
    );
    const out = await new GitHubForge(env(x)).listOpenChanges(repo, 5);
    for (const c of out.changes) {
      expect(c).not.toHaveProperty('changedFiles');
      expect(c).not.toHaveProperty('crossRepo');
      expect(c).not.toHaveProperty('headSha');
    }
  });
});
