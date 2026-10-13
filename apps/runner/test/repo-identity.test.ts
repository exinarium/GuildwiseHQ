import { describe, expect, it } from 'vitest';
import { repoIdentity } from '../src/git/git.ts';
import { rebaseEnv } from '../src/git/rebase.ts';
import { cleanupTmp, makeRepo, sh } from './helpers.ts';

cleanupTmp();

describe('git identity of runner-made commits', () => {
  it('uses the repository configured identity, the runner identity only when none is set', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['config', 'user.name', 'Pieter']);
    sh(repo.clone, 'git', ['config', 'user.email', 'pieter@example.test']);
    expect(await repoIdentity(repo.clone, { name: 'x', email: 'y' })).toEqual({
      name: 'Pieter',
      email: 'pieter@example.test',
    });
    expect(await rebaseEnv(repo.clone)).toEqual({
      GIT_COMMITTER_NAME: 'Pieter',
      GIT_COMMITTER_EMAIL: 'pieter@example.test',
    });
  });
});
