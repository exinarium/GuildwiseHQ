import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RepoReportSchema, ReviewerTokenFactSchema } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { reviewerTokenStatusLines, setReviewerToken } from '../src/review/reviewer-token-cli.ts';
import {
  FileReviewerTokenStore,
  MemoryReviewerTokenStore,
  reviewerTokenFact,
} from '../src/review/reviewer-tokens.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();
const TOKEN = 'github_pat_FAKE_store_0123456789';
const URL = 'https://github.com/acme/toy.git';
const key = () => Buffer.alloc(32, 7);

describe('the reviewer token store', () => {
  it('keeps the token sealed on disk (mode 0600), keyed by the normalized remote, and never lists the value', () => {
    const dir = tmp();
    const file = join(dir, 'secrets', 'reviewer-tokens.json');
    const s = new FileReviewerTokenStore(file, key);
    s.set(URL, TOKEN);
    expect(readFileSync(file, 'utf8')).not.toContain(TOKEN);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    // the same repository by another spelling of its url
    expect(s.get('git@github.com:acme/toy.git')?.token).toBe(TOKEN);
    expect(s.has('github.com/acme/toy')).toBe(true);
    expect(JSON.stringify(s.list())).not.toContain(TOKEN);
    expect(new FileReviewerTokenStore(file, key).has(URL)).toBe(true);
    expect(s.remove(URL)).toBe(true);
    expect(s.has(URL)).toBe(false);
  });

  it('is separate from the git host logins: nothing is written to git-tokens.json', () => {
    const dir = tmp();
    new FileReviewerTokenStore(join(dir, 'reviewer-tokens.json'), key).set(URL, TOKEN);
    expect(() => readFileSync(join(dir, 'git-tokens.json'))).toThrow();
  });

  it('an unreadable file is reported as a problem and is not overwritten by a new token', () => {
    const dir = tmp();
    const file = join(dir, 'reviewer-tokens.json');
    new FileReviewerTokenStore(file, key).set(URL, TOKEN);
    const other = new FileReviewerTokenStore(file, () => Buffer.alloc(32, 9));
    expect(other.problem()).toMatch(/cannot be read/);
    expect(other.has(URL)).toBe(false);
    other.set('github.com/acme/other', 'github_pat_FAKE_other');
    // the old file was moved aside, not destroyed
    expect(new FileReviewerTokenStore(file, key).has(URL)).toBe(false);
  });
});

describe('AC3: what the workstation reports is a fact, never the token', () => {
  it('the fact says present, missing or why it cannot be used', () => {
    const s = new MemoryReviewerTokenStore();
    expect(reviewerTokenFact(s, URL)).toEqual({ present: false });
    s.set(URL, TOKEN);
    expect(reviewerTokenFact(s, URL)).toEqual({ present: true });
    s.set('https://gitlab.com/acme/toy.git', TOKEN);
    expect(reviewerTokenFact(s, 'https://gitlab.com/acme/toy.git')).toEqual({
      present: false,
      problem: 'unsupported_host',
    });
    s.problemText = 'unreadable';
    expect(reviewerTokenFact(s, URL)).toEqual({ present: false, problem: 'unreadable' });
  });

  it('the repos.report entry holds the flag and the token is not in it; a token key is refused', () => {
    const s = new MemoryReviewerTokenStore();
    s.set(URL, TOKEN);
    const entry = {
      remoteUrl: URL,
      localPath: '/x',
      headBranch: 'main',
      reviewerToken: reviewerTokenFact(s, URL),
    };
    expect(RepoReportSchema.parse(entry).reviewerToken).toEqual({ present: true });
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
    expect(ReviewerTokenFactSchema.safeParse({ present: true, token: TOKEN }).success).toBe(false);
    expect(
      RepoReportSchema.safeParse({ ...entry, reviewerToken: { present: true, token: TOKEN } }).success,
    ).toBe(false);
  });
});

describe('reviewer-token set', () => {
  const host = (status: number, scopes?: string) =>
    (async () =>
      new Response('{}', {
        status,
        headers: scopes === undefined ? {} : { 'x-oauth-scopes': scopes },
      })) as unknown as typeof fetch;

  it('saves a token the host accepts for the repository', async () => {
    const store = new MemoryReviewerTokenStore();
    expect(await setReviewerToken({ store, remoteUrl: URL, token: TOKEN, fetch: host(200) })).toEqual({
      ok: true,
    });
    expect(store.has(URL)).toBe(true);
  });

  it('saves nothing when the host does not accept it, for a non-GitHub host or with no token', async () => {
    const store = new MemoryReviewerTokenStore();
    expect((await setReviewerToken({ store, remoteUrl: URL, token: TOKEN, fetch: host(404) })).ok).toBe(
      false,
    );
    expect(
      (
        await setReviewerToken({
          store,
          remoteUrl: 'https://gitlab.com/a/b.git',
          token: TOKEN,
          fetch: host(200),
        })
      ).ok,
    ).toBe(false);
    expect((await setReviewerToken({ store, remoteUrl: URL, token: '', fetch: host(200) })).ok).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('refuses a classic token that can write', async () => {
    const store = new MemoryReviewerTokenStore();
    for (const scopes of ['repo', 'public_repo, read:user', 'write:packages'])
      expect(
        (await setReviewerToken({ store, remoteUrl: URL, token: TOKEN, fetch: host(200, scopes) })).ok,
      ).toBe(false);
    expect(store.has(URL)).toBe(false);
    // a classic token with read-only scopes passes
    expect(
      (await setReviewerToken({ store, remoteUrl: URL, token: TOKEN, fetch: host(200, 'read:user') })).ok,
    ).toBe(true);
  });

  it('status prints present or missing and never the value', () => {
    const store = new MemoryReviewerTokenStore();
    expect(reviewerTokenStatusLines(store, URL)).toEqual([`${URL}: missing`]);
    store.set(URL, TOKEN);
    expect(reviewerTokenStatusLines(store, URL)).toEqual([`${URL}: present`]);
    expect(reviewerTokenStatusLines(store).join('\n')).not.toContain(TOKEN);
  });
});
