import { describe, expect, it } from 'vitest';
import { normalizeRemoteUrl } from '../src/index.ts';

describe('normalizeRemoteUrl across git hosts', () => {
  const same = (expected: string, urls: string[]) => {
    for (const u of urls) expect(normalizeRemoteUrl(u), u).toBe(expected);
  };
  it('maps the https and ssh forms of an Azure DevOps repo to one key', () => {
    same('dev.azure.com/acme/shop/_git/web', [
      'https://dev.azure.com/acme/shop/_git/web',
      'https://acme@dev.azure.com/acme/shop/_git/web',
      'git@ssh.dev.azure.com:v3/acme/shop/web',
      'ssh://git@ssh.dev.azure.com/v3/acme/shop/web',
      'https://acme.visualstudio.com/shop/_git/web',
      'https://acme.visualstudio.com/DefaultCollection/shop/_git/web',
      'git@vs-ssh.visualstudio.com:v3/acme/shop/web',
    ]);
    same('dev.azure.com/acme/my project/_git/web', [
      'https://dev.azure.com/acme/My%20Project/_git/web',
      'git@ssh.dev.azure.com:v3/acme/My Project/web',
    ]);
    same('dev.azure.com/acme/shop/_git/shop', [
      'https://dev.azure.com/acme/_git/shop',
      'git@ssh.dev.azure.com:v3/acme/shop/shop',
    ]);
  });
  it('maps the https and ssh forms of a Bitbucket Data Center repo to one key', () => {
    same('bb.corp.example/scm/proj/repo', [
      'https://bb.corp.example/scm/proj/repo.git',
      'https://user@bb.corp.example/scm/proj/repo.git',
      'https://bb.corp.example/bitbucket/scm/proj/repo.git',
      'ssh://git@bb.corp.example:7999/proj/repo.git',
    ]);
  });
  it('leaves GitHub, GitLab subgroups and Bitbucket Cloud alone', () => {
    expect(normalizeRemoteUrl('https://github.com/scm/tools.git')).toBe('github.com/scm/tools');
    expect(normalizeRemoteUrl('git@gitlab.com:grp/sub/app.git')).toBe('gitlab.com/grp/sub/app');
    expect(normalizeRemoteUrl('https://x@bitbucket.org/ws/app.git')).toBe('bitbucket.org/ws/app');
    expect(normalizeRemoteUrl('git@bitbucket.org:ws/app.git')).toBe('bitbucket.org/ws/app');
  });
});
