import { describe, expect, it } from 'vitest';
import {
  AppAccessCheckResultSchema,
  COMMIT_IDENTITY_SOURCE_LABEL,
  COMMIT_IDENTITY_SOURCES,
  CommandPayloadSchemas,
  type CommitAs,
  CommitAsResponseSchema,
  DomainEventSchema,
  FinalizeExecutePayloadSchema,
  oneAppPerProviderMessage,
  type PostAsAppIdentity,
  PostAsPlanSchema,
  postAsFor,
  RepoIdentityFactSchema,
  resolvePostAsRepo,
  type SelectedAppState,
  ShiftStartSchema,
} from '../src/index.ts';

const APP_ID = '0190f1a0-0000-7000-8000-000000000001';
const REPO_A = '0190f1a0-0000-7000-8000-00000000000a';
const REPO_B = '0190f1a0-0000-7000-8000-00000000000b';

const identity: PostAsAppIdentity = {
  integrationId: APP_ID,
  provider: 'github-app',
  label: 'Acme bot',
  botName: 'acme-bot[bot]',
  botEmail: '123+acme-bot[bot]@users.noreply.github.com',
  instance: '42:777',
  host: 'github.com',
};
const app = (over: Partial<SelectedAppState> = {}): SelectedAppState => ({
  ref: { integrationId: APP_ID, provider: 'github-app' },
  identity,
  removed: false,
  ...over,
});
const commitAs: CommitAs = { name: 'Pieter', email: 'p@example.com' };
const repo = { repoId: REPO_A, remoteUrlNormalized: 'github.com/acme/a', forge: 'github' as const };

describe('resolvePostAsRepo (the single resolver)', () => {
  it('app covering the repository -> app', () => {
    const r = resolvePostAsRepo({ repo, selected: [app()], access: () => 'covered', commitAs });
    expect(r).toEqual({
      repoId: REPO_A,
      remoteUrlNormalized: 'github.com/acme/a',
      source: 'app',
      app: identity,
    });
  });

  it('coverage unknown or errored -> still app (fail closed)', () => {
    expect(resolvePostAsRepo({ repo, selected: [app()], access: () => null, commitAs }).source).toBe('app');
    expect(resolvePostAsRepo({ repo, selected: [app()], access: () => 'error', commitAs: null }).source).toBe(
      'app',
    );
  });

  it('app not covering the repository -> Commit as, else repo, with the reason', () => {
    expect(resolvePostAsRepo({ repo, selected: [app()], access: () => 'not_covered', commitAs })).toEqual({
      repoId: REPO_A,
      remoteUrlNormalized: 'github.com/acme/a',
      source: 'project',
      fallbackReason: 'not_covered',
    });
    const r = resolvePostAsRepo({ repo, selected: [app()], access: () => 'not_covered', commitAs: null });
    expect(r.source).toBe('repo');
    expect(r.app).toBeUndefined();
  });

  it('removed app -> fallback with app_removed', () => {
    for (const s of [app({ removed: true }), app({ identity: null })]) {
      const r = resolvePostAsRepo({ repo, selected: [s], access: () => 'covered', commitAs });
      expect(r).toMatchObject({ source: 'project', fallbackReason: 'app_removed' });
    }
  });

  it('no app for the repository forge -> no_app_for_forge', () => {
    const r = resolvePostAsRepo({
      repo: { ...repo, forge: 'gitlab' },
      selected: [app()],
      access: () => 'covered',
      commitAs: null,
    });
    expect(r).toMatchObject({ source: 'repo', fallbackReason: 'no_app_for_forge' });
  });

  it('nothing selected -> today: Commit as or repo, no reason', () => {
    expect(resolvePostAsRepo({ repo, selected: [], access: () => null, commitAs })).toEqual({
      repoId: REPO_A,
      remoteUrlNormalized: 'github.com/acme/a',
      source: 'project',
    });
    expect(resolvePostAsRepo({ repo, selected: [], access: () => null, commitAs: null }).source).toBe('repo');
  });

  it('postAsFor finds the entry by remote', () => {
    const plan = PostAsPlanSchema.parse({
      repos: [
        { repoId: REPO_A, remoteUrlNormalized: 'github.com/acme/a', source: 'app', app: identity },
        {
          repoId: REPO_B,
          remoteUrlNormalized: 'github.com/acme/b',
          source: 'repo',
          fallbackReason: 'not_covered',
        },
      ],
    });
    expect(postAsFor(plan, 'github.com/acme/b')?.repoId).toBe(REPO_B);
    expect(postAsFor(plan, 'github.com/acme/c')).toBeNull();
    expect(postAsFor(null, 'github.com/acme/a')).toBeNull();
    expect(postAsFor(plan, null)).toBeNull();
  });
});

describe('commit identity source', () => {
  it("'app' is appended; old values still parse", () => {
    expect(COMMIT_IDENTITY_SOURCES).toEqual(['project', 'repo', 'global', 'system', 'app']);
    expect(COMMIT_IDENTITY_SOURCE_LABEL.app).toBe("the project's selected app");
    for (const source of ['project', 'repo', 'global', 'system', 'app'])
      expect(RepoIdentityFactSchema.parse({ name: 'n', email: 'e@x.y', source }).source).toBe(source);
  });

  it('an old settings response (no postAs, no repos) still parses', () => {
    expect(CommitAsResponseSchema.parse({ commitAs: null, clones: [] })).toEqual({
      commitAs: null,
      clones: [],
    });
  });
});

describe('ProjectPostAsAppsSet event', () => {
  it('carries actor, old and new references only', () => {
    const data = {
      projectId: REPO_A,
      apps: [{ integrationId: APP_ID, provider: 'github-app' }],
      previous: [],
      setBy: REPO_B,
    };
    expect(DomainEventSchema.parse({ type: 'ProjectPostAsAppsSet', payload: data }).payload).toEqual(data);
  });

  it('old ProjectCommitAsSet events still parse', () => {
    expect(
      DomainEventSchema.parse({ type: 'ProjectCommitAsSet', payload: { projectId: REPO_A, commitAs: null } })
        .payload,
    ).toEqual({ projectId: REPO_A, commitAs: null });
  });
});

describe('protocol', () => {
  const plan = {
    repos: [
      { repoId: REPO_A, remoteUrlNormalized: 'github.com/acme/a', source: 'app' as const, app: identity },
    ],
  };

  it('finalize.execute without postAs parses to exactly the old object; with postAs it round-trips', () => {
    const base = {
      cardId: REPO_A,
      ref: 'TOY-1',
      title: 't',
      projectKey: 'TOY',
      action: 'merge',
      repoId: REPO_B,
      remoteUrlNormalized: 'github.com/acme/a',
      baseBranch: 'main',
      branchName: 'b',
      worktreePath: null,
      commitAs,
    };
    const old = FinalizeExecutePayloadSchema.parse(base);
    expect('postAs' in old).toBe(false);
    expect(old).toEqual(base);
    expect(FinalizeExecutePayloadSchema.parse({ ...base, postAs: plan }).postAs).toEqual(plan);
    expect(CommandPayloadSchemas['finalize.execute'].parse({ ...base, postAs: plan }).postAs).toEqual(plan);
  });

  it('shift.start carries the resolved post-as plan to the runner (serialisation round trip)', () => {
    const postAs = ShiftStartSchema.shape.postAs;
    expect(postAs).toBeDefined();
    expect(postAs.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(postAs.parse(undefined)).toBeUndefined();
  });

  it('app.access_check is a runner command; its result is strict (no token can ride along)', () => {
    expect(
      CommandPayloadSchemas['app.access_check'].parse({
        projectId: REPO_A,
        integrationId: APP_ID,
        instance: '42:777',
        host: 'github.com',
        repos: [{ repoId: REPO_A, remoteUrlNormalized: 'github.com/acme/a' }],
      }).instance,
    ).toBe('42:777');
    expect(
      AppAccessCheckResultSchema.safeParse({ repos: [{ repoId: REPO_A, state: 'covered', token: 'x' }] })
        .success,
    ).toBe(false);
    expect(
      AppAccessCheckResultSchema.parse({
        repos: [{ repoId: REPO_A, state: 'error', code: 'installation_suspended', detail: 'suspended' }],
      }).repos[0]?.code,
    ).toBe('installation_suspended');
  });

  it('one app per provider message names the provider and the other app', () => {
    expect(oneAppPerProviderMessage('github-app', 'Acme bot')).toBe(
      'A project can post as one GitHub App only; untick Acme bot first',
    );
  });
});
