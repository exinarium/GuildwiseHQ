import { describe, expect, it } from 'vitest';
import {
  AddRepoRequestSchema,
  CreateProjectRequestSchema,
  isHttpUrl,
  isSafeBranchPrefix,
  isSafeGitRef,
  isSafeVaultFolder,
  parseRemoteUrl,
  RegisterVaultRequestSchema,
  remoteUrlError,
  scrubRemoteUrl,
} from '../src/index.ts';

describe('git refs (review M1)', () => {
  it('accepts ordinary branches and rejects option-like or malformed refs', () => {
    for (const ok of ['main', 'release/1.2', 'aom/web-12-add-login', 'feature/x_y'])
      expect(isSafeGitRef(ok), ok).toBe(true);
    for (const bad of [
      '',
      '-D',
      '--upload-pack=evil',
      'a..b',
      'a b',
      'a:b',
      'a^',
      'a~1',
      'a?',
      'a*',
      'a[',
      'a\\b',
      '/a',
      'a/',
      'a//b',
      '.hidden',
      'a/.b',
      'x.lock',
      'a@{1}',
      '@',
      'a.',
      'a\nb',
    ])
      expect(isSafeGitRef(bad), JSON.stringify(bad)).toBe(false);
  });
  it('branch prefixes', () => {
    expect(isSafeBranchPrefix('aom/')).toBe(true);
    expect(isSafeBranchPrefix('')).toBe(true);
    expect(isSafeBranchPrefix('-x/')).toBe(false);
    expect(isSafeBranchPrefix('../')).toBe(false);
  });
  it('vault folders stay inside the vault', () => {
    expect(isSafeVaultFolder('projects/web')).toBe(true);
    for (const bad of ['..', '../x', 'a/../b', '/etc', 'C:\\x', 'a\\b', '.git/hooks', '', 'a//b'])
      expect(isSafeVaultFolder(bad), bad).toBe(false);
  });
});

describe('remote URLs (review M1, M5)', () => {
  it('allows https, ssh and scp-style user-only remotes', () => {
    expect(parseRemoteUrl('https://github.com/acme/web.git')).toEqual({ ok: true, kind: 'https' });
    expect(parseRemoteUrl('ssh://git@github.com/acme/web.git')).toEqual({ ok: true, kind: 'ssh' });
    expect(parseRemoteUrl('git@github.com:acme/web.git')).toEqual({ ok: true, kind: 'ssh' });
  });
  it('rejects credentials, option-like and exotic transports', () => {
    for (const bad of [
      'https://user:token@github.com/a/b.git',
      'https://ghp_token@github.com/a/b.git',
      'ssh://git:secret@host/a/b.git',
      '--upload-pack=touch /tmp/x',
      'ext::sh -c touch% /tmp/x',
      'ftp://host/a',
      'http://host/a',
      'git://host/a',
      'javascript:alert(1)',
      'github.com/a/b',
      '',
    ])
      expect(parseRemoteUrl(bad).ok, bad).toBe(false);
  });
  it('local paths and file:// need the explicit allowance', () => {
    expect(remoteUrlError('file:///tmp/x.git', false)).toMatch(/not allowed/);
    expect(remoteUrlError('/tmp/x.git', false)).toMatch(/not allowed/);
    expect(remoteUrlError('/tmp/x.git', true)).toBeNull();
  });
  it('scrubs stored passwords and tokens but keeps ssh users', () => {
    expect(scrubRemoteUrl('https://u:p@h.com/a.git')).toBe('https://h.com/a.git');
    expect(scrubRemoteUrl('https://tok@h.com/a.git')).toBe('https://h.com/a.git');
    expect(scrubRemoteUrl('ssh://git:p@h.com/a.git')).toBe('ssh://git@h.com/a.git');
    expect(scrubRemoteUrl('ssh://git@h.com/a.git')).toBe('ssh://git@h.com/a.git');
    expect(scrubRemoteUrl('git@h.com:a.git')).toBe('git@h.com:a.git');
  });
  it('the API schemas apply them', () => {
    expect(AddRepoRequestSchema.safeParse({ name: 'x', remoteUrl: 'https://u:p@h.com/a' }).success).toBe(
      false,
    );
    expect(
      AddRepoRequestSchema.safeParse({ name: 'x', remoteUrl: 'https://h.com/a', workingBranch: '-x' })
        .success,
    ).toBe(false);
    expect(CreateProjectRequestSchema.safeParse({ key: 'WEB', name: 'w', branchPrefix: '--x' }).success).toBe(
      false,
    );
    expect(CreateProjectRequestSchema.safeParse({ key: 'WEB', name: 'w', vaultFolder: '../x' }).success).toBe(
      false,
    );
    expect(
      RegisterVaultRequestSchema.safeParse({ kind: 'work', remoteUrl: 'https://u:p@h.com/v.git' }).success,
    ).toBe(false);
    expect(RegisterVaultRequestSchema.safeParse({ kind: 'work', remoteUrl: 'git@h.com:v.git' }).success).toBe(
      true,
    );
  });
});

describe('http urls (review low)', () => {
  it('only http(s) is a link', () => {
    expect(isHttpUrl('https://example.com/a')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.com', 'not a url', '//evil.com'])
      expect(isHttpUrl(bad), bad).toBe(false);
  });
});

describe('feed and citation URLs are http(s) only (review low)', () => {
  it('rejects javascript: and data: URLs in items and citations', async () => {
    const { FeedItemInputSchema, CitationSchema } = await import('../src/index.ts');
    const item = { kind: 'article', title: 't', source: 's', summary: 'x', publishedAt: '2026-01-01' };
    expect(FeedItemInputSchema.safeParse({ ...item, url: 'javascript:alert(1)' }).success).toBe(false);
    expect(FeedItemInputSchema.safeParse({ ...item, url: 'data:text/html,x' }).success).toBe(false);
    expect(FeedItemInputSchema.safeParse({ ...item, url: 'https://example.com/a' }).success).toBe(true);
    expect(
      CitationSchema.safeParse({ url: 'javascript:alert(1)', title: 't', accessedAt: '2026-01-01T00:00:00Z' })
        .success,
    ).toBe(false);
  });
});
