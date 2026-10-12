import { describe, expect, it } from 'vitest';
import {
  httpsRemoteUrl,
  isSshRemote,
  normalizeRemoteUrl,
  remoteUrlForMethod,
  settingsHostFor,
  sshHostFor,
  sshRemoteUrl,
} from '../src/index.ts';

describe('sshRemoteUrl (https to ssh per provider)', () => {
  it.each([
    ['https://github.com/acme/web', 'git@github.com:acme/web.git'],
    ['https://github.com/acme/web.git', 'git@github.com:acme/web.git'],
    ['https://github.example.com/Acme/Web.git', 'git@github.example.com:Acme/Web.git'],
    ['https://gitlab.com/group/sub/web.git', 'git@gitlab.com:group/sub/web.git'],
    ['https://gitlab.company.io/team/web', 'git@gitlab.company.io:team/web.git'],
    ['https://bitbucket.org/ws/repo.git', 'git@bitbucket.org:ws/repo.git'],
    ['https://user@bitbucket.org/ws/repo.git', 'git@bitbucket.org:ws/repo.git'],
    ['https://dev.azure.com/org/proj/_git/repo', 'git@ssh.dev.azure.com:v3/org/proj/repo'],
    ['https://org@dev.azure.com/org/My%20Proj/_git/repo', 'git@ssh.dev.azure.com:v3/org/My%20Proj/repo'],
    ['https://git.example.org/team/app.git', 'git@git.example.org:team/app.git'],
  ])('%s -> %s', (https, ssh) => {
    expect(sshRemoteUrl(https)).toBe(ssh);
    // The ssh form is the same repository as the https form.
    expect(normalizeRemoteUrl(ssh)).toBe(normalizeRemoteUrl(https));
  });

  it('keeps an ssh remote as it is', () => {
    expect(sshRemoteUrl('git@github.com:acme/web.git')).toBe('git@github.com:acme/web.git');
    expect(sshRemoteUrl('ssh://git@host:7999/PROJ/repo.git')).toBe('ssh://git@host:7999/PROJ/repo.git');
  });

  it('cannot derive the ssh address of Bitbucket Data Center (its ssh port is not in the https url)', () => {
    expect(sshRemoteUrl('https://bitbucket.corp.example/scm/PROJ/repo.git')).toBeNull();
  });

  it('refuses things that are not remotes', () => {
    expect(sshRemoteUrl('/tmp/origin.git')).toBeNull();
    expect(sshRemoteUrl('file:///tmp/origin.git')).toBeNull();
    expect(sshRemoteUrl('https://github.com/')).toBeNull();
  });
});

describe('httpsRemoteUrl (the way back)', () => {
  it.each([
    ['git@github.com:acme/web.git', 'https://github.com/acme/web.git'],
    ['git@bitbucket.org:ws/repo.git', 'https://bitbucket.org/ws/repo.git'],
    ['git@gitlab.com:group/sub/web.git', 'https://gitlab.com/group/sub/web.git'],
    ['git@ssh.dev.azure.com:v3/org/proj/repo', 'https://dev.azure.com/org/proj/_git/repo'],
    [
      'ssh://git@bitbucket.corp.example:7999/PROJ/repo.git',
      'https://bitbucket.corp.example/scm/PROJ/repo.git',
    ],
  ])('%s -> %s', (ssh, https) => {
    expect(httpsRemoteUrl(ssh)).toBe(https);
    expect(normalizeRemoteUrl(https)).toBe(normalizeRemoteUrl(ssh));
  });

  it('keeps an https remote as it is', () => {
    expect(httpsRemoteUrl('https://github.com/acme/web')).toBe('https://github.com/acme/web');
  });

  it('round trips', () => {
    for (const u of [
      'https://github.com/acme/web.git',
      'https://dev.azure.com/org/proj/_git/repo',
      'https://bitbucket.org/ws/repo.git',
    ])
      expect(httpsRemoteUrl(sshRemoteUrl(u) as string)).toBe(u);
  });
});

describe('helpers', () => {
  it('remoteUrlForMethod picks the form', () => {
    expect(remoteUrlForMethod('https://github.com/a/b', 'ssh')).toBe('git@github.com:a/b.git');
    expect(remoteUrlForMethod('git@github.com:a/b.git', 'https')).toBe('https://github.com/a/b.git');
  });
  it('isSshRemote', () => {
    expect(isSshRemote('git@github.com:a/b.git')).toBe(true);
    expect(isSshRemote('ssh://git@h/a/b')).toBe(true);
    expect(isSshRemote('https://github.com/a/b')).toBe(false);
    expect(isSshRemote('/tmp/x.git')).toBe(false);
  });
  it('maps the azure ssh host', () => {
    expect(sshHostFor('dev.azure.com')).toBe('ssh.dev.azure.com');
    expect(sshHostFor('github.com')).toBe('github.com');
    expect(settingsHostFor('ssh.dev.azure.com')).toBe('dev.azure.com');
  });
});
