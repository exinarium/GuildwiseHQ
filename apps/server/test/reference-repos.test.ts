import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { projectReadRepos, referenceReadRepos } from '../src/runner-gateway/read-repos.ts';
import { uniqueEmail } from './helpers/app.ts';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember } from './helpers/members.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let libId: string;
let libRepoId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  const lib = await ok<any>(
    w.t.req('POST', '/api/projects', { cookie: w.owner.cookie, body: { key: 'LIB', name: 'Library' } }),
    201,
  );
  libId = lib.project.id;
  const added = await ok<any>(
    w.t.req('POST', `/api/projects/${libId}/repos`, {
      cookie: w.owner.cookie,
      body: { name: 'lib', remoteUrl: 'https://github.com/acme/lib.git' },
    }),
    201,
  );
  libRepoId = added.repos[0].id;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const put = (cookie: string, repoIds: string[], projectId = w.projectId) =>
  w.t.req('PUT', `/api/projects/${projectId}/reference-repos`, { cookie, body: { repoIds } });

describe('project reference repositories', () => {
  it("offers the repositories of the owner's other projects as candidates", async () => {
    const d = await ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: w.owner.cookie }));
    expect(d.referenceRepos).toEqual([]);
    expect(d.referenceRepoCandidates).toHaveLength(1);
    expect(d.referenceRepoCandidates[0]).toMatchObject({
      repoId: libRepoId,
      name: 'lib',
      projectName: 'Library',
    });
    // a project never offers its own repositories
    const own = await ok<any>(w.t.req('GET', `/api/projects/${libId}`, { cookie: w.owner.cookie }));
    expect(own.referenceRepoCandidates.map((c: any) => c.repoId)).toEqual([w.repoId]);
  });

  it('the owner sets, replaces and clears the list; it is stored by repo id as an event', async () => {
    const set = await ok<any>(put(w.owner.cookie, [libRepoId, libRepoId]));
    expect(set.referenceRepos.map((r: any) => r.repoId)).toEqual([libRepoId]);
    expect(
      await q(`SELECT payload FROM events WHERE type='ProjectReferenceReposSet' AND project_id=$1`, [
        w.projectId,
      ]),
    ).toHaveLength(1);
    // the same list again appends nothing
    await ok(put(w.owner.cookie, [libRepoId]));
    expect(
      await q(`SELECT 1 FROM events WHERE type='ProjectReferenceReposSet' AND project_id=$1`, [w.projectId]),
    ).toHaveLength(1);
    expect(
      (await referenceReadRepos(w.t.app.ctx.pool, w.projectId)).map((r) => r.remoteUrlNormalized),
    ).toEqual(['github.com/acme/lib']);
    // survives a projection rebuild
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await referenceReadRepos(w.t.app.ctx.pool, w.projectId)).map((r) => r.repoId)).toEqual([
      libRepoId,
    ]);
    const cleared = await ok<any>(put(w.owner.cookie, []));
    expect(cleared.referenceRepos).toEqual([]);
    expect(await referenceReadRepos(w.t.app.ctx.pool, w.projectId)).toEqual([]);
    await ok(put(w.owner.cookie, [libRepoId]));
  });

  it("refuses unknown repositories, the project's own repository and other users' projects", async () => {
    expect((await put(w.owner.cookie, [w.repoId])).status).toBe(400);
    expect((await put(w.owner.cookie, ['00000000-0000-4000-8000-000000000001'])).status).toBe(400);
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    const theirs = await ok<any>(
      w.t.req('POST', '/api/projects', { cookie: stranger.cookie, body: { key: 'SEC', name: 'Secret' } }),
      201,
    );
    const repo = await ok<any>(
      w.t.req('POST', `/api/projects/${theirs.project.id}/repos`, {
        cookie: stranger.cookie,
        body: { name: 'sec', remoteUrl: 'https://github.com/acme/sec' },
      }),
      201,
    );
    expect((await put(w.owner.cookie, [repo.repos[0].id])).status).toBe(400);
    expect((await put(w.owner.cookie, [libRepoId, ...Array(20).fill(libRepoId)])).status).toBe(400); // too many
  });

  it('is owner only: a manager sees the list but no candidates and cannot change it', async () => {
    const m = await addMember(w, 'ref-manager');
    expect((await put(m.cookie, [])).status).toBe(403);
    const d = await ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: m.cookie }));
    expect(d.referenceRepos).toHaveLength(1);
    expect(d.referenceRepoCandidates).toEqual([]);
  });

  it('drops a removed repository from what agents may read', async () => {
    await ok(w.t.req('DELETE', `/api/projects/${libId}/repos/${libRepoId}`, { cookie: w.owner.cookie }));
    expect(await referenceReadRepos(w.t.app.ctx.pool, w.projectId)).toEqual([]);
    await ok(
      w.t.req('POST', `/api/projects/${libId}/repos`, {
        cookie: w.owner.cookie,
        body: { name: 'lib', remoteUrl: 'https://github.com/acme/lib.git' },
      }),
      201,
    );
    expect((await referenceReadRepos(w.t.app.ctx.pool, w.projectId)).map((r) => r.repoId)).toEqual([
      libRepoId,
    ]);
  });

  it("a project chat starts with the project's repositories and its reference repositories", async () => {
    const r = await w.connectRunner();
    const agent = await w.hire('Rex', 'builder', 'junior');
    const chat = (
      await ok<any>(
        w.t.req('POST', '/api/chats', {
          cookie: w.owner.cookie,
          body: { agentId: agent.id, projectId: w.projectId },
        }),
        201,
      )
    ).chat;
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'compare', clientMsgId: 'm1' });
    const start = await r.waitFor('chat.start');
    expect(start.context.readRepos).toEqual([
      expect.objectContaining({ repoId: w.repoId, kind: 'project' }),
      expect.objectContaining({
        repoId: libRepoId,
        kind: 'reference',
        remoteUrlNormalized: 'github.com/acme/lib',
      }),
    ]);
    expect((await projectReadRepos(w.t.app.ctx.pool, w.projectId)).map((x) => x.repoId)).toEqual([w.repoId]);
    b.close();
    r.close();
  });

  it('a business analyst chat gets no repository at all (#47: the Architect reads code, the BA specifies)', async () => {
    const r = await w.connectRunner();
    const agent = await w.hire('Bea', 'ba', 'senior');
    const chat = (
      await ok<any>(
        w.t.req('POST', '/api/chats', {
          cookie: w.owner.cookie,
          body: { agentId: agent.id, projectId: w.projectId },
        }),
        201,
      )
    ).chat;
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'what does it say', clientMsgId: 'm2' });
    const start = await r.waitFor('chat.start');
    expect(start.context.readRepos).toBeUndefined();
    expect(start.context.localReadRepos).toBeUndefined();
    expect(start.context.cardWorktreePath).toBeUndefined();
    b.close();
    r.close();
  });
});
