import { graphRepoKey, MIN_RUNNER_FOR_REPO_SCOPING } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baTaskPass } from '../src/dispatcher/ba-tasks.ts';
import { act, appoint, keepOnline, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * Repository scoping (docs/ARCHITECTURE.md, "Repository scoping"): a card with no repository in a project with several is
 * never put to the CEO as a question. The BA (or, as the fallback, an architect) finds the repository through the project
 * code graph, and names one or splits the card into one per repository or section.
 */
let w: World;
let r: FakeRunner;
const repoIds = {} as { api: string; web: string; toy: string; [k: string]: string };
const ctx = () => w.t.app.ctx;
const text = 'Customers cannot reset their password from the mobile app.\nThe link opens a blank page.';

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  for (const name of ['api', 'web']) {
    const added = await ok<any>(
      w.t.req('POST', `/api/projects/${w.projectId}/repos`, {
        cookie: w.owner.cookie,
        body: { name, remoteUrl: `https://github.com/acme/${name}.git` },
      }),
      201,
    );
    repoIds[name] = added.repos.find((x: any) => x.name === name).id;
  }
  repoIds.toy = w.repoId;
  await q(`UPDATE workstations SET runner_version=$2 WHERE id=$1`, [
    w.workstationId,
    MIN_RUNNER_FOR_REPO_SCOPING,
  ]);
  await q(
    `INSERT INTO vaults (id, org_id, project_id, kind, name, remote_url, sync_interval_sec, created_at, storage)
     SELECT gen_random_uuid(), org_id, id, 'project', 'toy vault', 'https://github.com/acme/vault.git', 300, now(), 'git'
       FROM projects WHERE id=$1`,
    [w.projectId],
  );
  await indexGraphs();
  await w.hire('Ben', 'ba', 'senior');
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

/** Every repository of the project has an indexed graph (the BA can serve). */
async function indexGraphs(names = ['api', 'web', 'toy']) {
  await q('DELETE FROM project_graphs WHERE project_id=$1', [w.projectId]);
  for (const n of names) {
    const [repo] = await q('SELECT remote_url_normalized FROM project_repos WHERE id=$1', [repoIds[n]]);
    await q(
      `INSERT INTO project_graphs (project_id, repo_id, repo_key, org_id, status, commit_id, indexed_at, updated_at)
       SELECT $1, $2, $3, org_id, 'indexed', $4, now(), now() FROM projects WHERE id=$1`,
      [w.projectId, repoIds[n], graphRepoKey(repo!.remote_url_normalized), 'a'.repeat(40)],
    );
  }
}

/** A repo-less card: created like the web's "Not sure: let the BA find out". */
async function findRepoCard(title: string) {
  const res = await ok<any>(
    w.t.req('POST', '/api/cards', {
      cookie: w.owner.cookie,
      body: {
        projectId: w.projectId,
        title,
        cardType: 'feature',
        fields: { context: text },
        specify: true,
        findRepo: true,
      },
    }),
    201,
  );
  return res as { card: { id: string; ref: string }; message?: string; specified?: boolean };
}

const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;
const taskOf = async (cardId: string) => (await q('SELECT * FROM ba_tasks WHERE card_id=$1', [cardId]))[0]!;

/** Dispatches the queued scoping task and returns the `shift.start` the runner got. */
async function dispatch(role: 'ba' | 'architect' = 'ba') {
  await keepOnline(w);
  const from = r.received.length;
  await baTaskPass(ctx());
  const start = (await r.waitFor(
    'shift.start',
    (f) => f.kind === 'ba_task' && f.baTask?.kind === 'spec_card',
    8000,
    from,
  )) as any;
  r.accepted(start.shiftId);
  r.started(start.shiftId);
  const agent = (await q('SELECT role_key FROM agents WHERE id=$1', [start.agent?.id]))[0];
  if (agent) expect(agent.role_key).toBe(role);
  return start;
}

async function report(start: any, data: unknown) {
  const sent = r.report(start.shiftId, { kind: 'outcome', outcomeId: 'spec_card_done', note: 'done', data });
  return (await r.waitFor('shift.report.result', (f) => f.reportId === sent.reportId)) as any;
}
async function reportFail(start: any, note: string) {
  const sent = r.report(start.shiftId, { kind: 'outcome', outcomeId: 'spec_card_fail', note, data: {} });
  return (await r.waitFor('shift.report.result', (f) => f.reportId === sent.reportId)) as any;
}

/** The text fields the task asks for, filled. */
const fieldsFor = (start: any, label: string) => {
  const task = start.baTask.specCard;
  return Object.fromEntries(
    (task.missing as string[]).map((k) => [
      k,
      (task.listFields as string[]).includes(k) ? [`${k} of ${label}`] : `${k} of ${label}`,
    ]),
  );
};

describe('a card with no repository in a project with three', () => {
  it('goes to the BA, who names the repository; the card is specified with it', async () => {
    const made = await findRepoCard('Password reset is blank');
    expect(made.specified).toBe(false);
    expect(made.message).toContain('sent to the BA to find the repository');
    expect((await cardRow(made.card.id)).repo_id).toBeNull();
    expect(await taskOf(made.card.id)).toMatchObject({ kind: 'spec_card', status: 'queued' });

    const start = await dispatch('ba');
    const task = start.baTask.specCard;
    expect(task).toMatchObject({ chooseRepo: true, by: 'ba' });
    expect(task.repos.map((x: any) => x.name).sort()).toEqual(['api', 'toy', 'web']);
    expect(task.repos.every((x: any) => x.indexed)).toBe(true);
    // the BA reads no source: no repositories are opened for it
    expect(start.readRepos).toBeUndefined();

    // a scoping report with neither a repository nor a split is refused
    const none = await report(start, { fields: fieldsFor(start, 'none') });
    expect(none.accepted).toBe(false);
    expect(none.error).toContain('has no repository');
    // an unknown repository is refused with the list
    const bad = await report(start, { repo: 'mobile', fields: fieldsFor(start, 'bad') });
    expect(bad.accepted).toBe(false);
    expect(bad.error).toContain('unknown repo');

    const ok1 = await report(start, { repo: 'web', fields: fieldsFor(start, 'web') });
    expect(ok1.accepted, JSON.stringify(ok1)).toBe(true);
    const row = await cardRow(made.card.id);
    expect(row).toMatchObject({ repo_id: repoIds.web, status: 'queued' });
    expect((await taskOf(made.card.id)).status).toBe('done');
    r.ended(start.shiftId, 'reported');
  });

  it('can be split in two with a dependency: children, links, the parent cancelled as split, a note and a CEO wake', async () => {
    await appoint(w);
    await wakeNow(w);
    const made = await findRepoCard('Reset link broken across api and web');
    const parent = made.card.id;
    await q(`UPDATE cards SET priority=2 WHERE id=$1`, [parent]);
    const start = await dispatch('ba');
    const sent = await report(start, {
      split: [
        { title: 'API: issue a valid reset link', repo: 'api', fields: fieldsFor(start, 'api') },
        { title: 'Web: open the reset page', repo: 'web', fields: fieldsFor(start, 'web'), dependsOn: [1] },
      ],
    });
    expect(sent.accepted, JSON.stringify(sent)).toBe(true);

    const kids = await q('SELECT * FROM cards WHERE parent_card_id=$1 ORDER BY number', [parent]);
    expect(kids).toHaveLength(2);
    expect(kids[0]).toMatchObject({ repo_id: repoIds.api, status: 'queued', priority: 2 });
    expect(kids[1]).toMatchObject({ repo_id: repoIds.web, status: 'queued' });
    expect(kids[0]!.fields.context).toBe(text); // the parent's text carries over
    expect(String(kids[1]!.fields.requirements)).toContain('web');
    const deps = await q('SELECT depends_on_card_id FROM card_dependencies WHERE card_id=$1', [kids[1]!.id]);
    expect(deps.map((d) => d.depends_on_card_id)).toEqual([kids[0]!.id]);
    expect(await q('SELECT 1 FROM card_dependencies WHERE card_id=$1', [kids[0]!.id])).toHaveLength(0);

    const [cancelled] = await q(
      `SELECT payload FROM events WHERE type='CardCancelled' AND payload->>'cardId'=$1`,
      [parent],
    );
    expect(cancelled!.payload).toMatchObject({ cause: 'split', childCardIds: kids.map((k) => k.id) });
    expect((await cardRow(parent)).status).toBe('cancelled');
    const notes = await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='system'`, [parent]);
    expect(notes.map((n) => n.body).join('\n')).toContain(kids[0]!.ref);
    expect(notes.map((n) => n.body).join('\n')).toContain(kids[1]!.ref);
    expect((await taskOf(parent)).status).toBe('done');

    // the card page links both ways
    const detail = await ok<any>(w.t.req('GET', `/api/cards/${parent}`, { cookie: w.owner.cookie }));
    expect(detail.splitInto.map((c: any) => [c.ref, c.repoName])).toEqual([
      [kids[0]!.ref, 'api'],
      [kids[1]!.ref, 'web'],
    ]);
    const child = await ok<any>(w.t.req('GET', `/api/cards/${kids[1]!.id}`, { cookie: w.owner.cookie }));
    expect(child.splitFrom).toMatchObject({ id: parent });

    // the CEO is told which cards replaced it
    await ctx().notifier.flush();
    await until(
      async () => (await q(`SELECT 1 FROM ceo_wakes WHERE subject_id=$1`, [parent]))[0],
      3000,
      'split wake',
    );
    const wake = (await q(`SELECT * FROM ceo_wakes WHERE subject_id=$1`, [parent]))[0]!;
    const detailText = JSON.stringify(wake.detail);
    expect(detailText).toContain('split');
    expect(detailText).toContain(kids[0]!.ref);
    expect(detailText).toContain(kids[1]!.ref);
    r.ended(start.shiftId, 'reported');
  });

  it('refuses a split with an incomplete child and writes nothing', async () => {
    const made = await findRepoCard('Another cross-repo bug');
    const parent = made.card.id;
    const start = await dispatch('ba');
    const before = (await q('SELECT next_card_number FROM projects WHERE id=$1', [w.projectId]))[0]!;
    const cardEvents = `SELECT count(*)::int AS n FROM events WHERE type LIKE 'Card%'`;
    const eventsBefore = (await q(cardEvents))[0]!.n;
    const incomplete = fieldsFor(start, 'x');
    delete incomplete[Object.keys(incomplete)[0]!];
    const res = await report(start, {
      split: [
        { title: 'First is fine', repo: 'api', fields: fieldsFor(start, 'api') },
        { title: 'Second lacks a field', repo: 'web', fields: incomplete },
      ],
    });
    expect(res.accepted).toBe(false);
    expect(res.error).toContain('nothing was written');
    expect(res.error).toContain('child 2');
    expect(await q('SELECT 1 FROM cards WHERE parent_card_id=$1', [parent])).toHaveLength(0);
    expect((await cardRow(parent)).status).toBe('draft');
    expect((await q('SELECT next_card_number FROM projects WHERE id=$1', [w.projectId]))[0]).toEqual(before);
    expect((await q(cardEvents))[0]!.n).toBe(eventsBefore);
    expect((await taskOf(parent)).status).toBe('running');

    // a forward dependency and an unknown repository are refused too, with everything wrong listed
    const bad = await report(start, {
      split: [
        { title: 'One', repo: 'api', fields: fieldsFor(start, 'a'), dependsOn: [2] },
        { title: 'Two', repo: 'mobile', fields: fieldsFor(start, 'b') },
      ],
    });
    expect(bad.accepted).toBe(false);
    expect(bad.error).toContain('not an earlier child');
    expect(bad.error).toContain('unknown repo');
    expect((await cardRow(parent)).status).toBe('draft');

    // the BA can still fix it in the same shift
    const fixed = await report(start, { repo: 'api', fields: fieldsFor(start, 'api') });
    expect(fixed.accepted, JSON.stringify(fixed)).toBe(true);
    r.ended(start.shiftId, 'reported');
  });

  it('when the BA cannot tell, the card goes to the CEO first, not the owner', async () => {
    await appoint(w);
    const made = await findRepoCard('Something is wrong somewhere');
    const start = await dispatch('ba');
    const res = await reportFail(start, 'The graph shows nothing for these words in any repository');
    expect(res.accepted).toBe(true);
    const [item] = await q(`SELECT * FROM desk_items WHERE card_id=$1 AND subkind='spec_needed'`, [
      made.card.id,
    ]);
    expect(item).toMatchObject({ pinned: false, status: 'open', triage: 'pending' });
    expect(item!.triage_deadline).toBeTruthy(); // held for the CEO's triage; the owner sees it when the hold ends
    expect(item!.title).toContain('needs a repository');
    expect((await cardRow(made.card.id)).status).toBe('draft');
    await ctx().notifier.flush();
    await until(
      async () => (await q(`SELECT 1 FROM ceo_wakes WHERE subject_id=$1`, [item!.id]))[0],
      3000,
      'ceo wake for the item',
    );
    r.ended(start.shiftId, 'reported');
  });

  it('a card that needs no repository scoping keeps the pinned owner alert on failure', async () => {
    const card = await w.card({ title: 'Has everything but text', fields: { context: 'x' }, specify: false });
    await q(`UPDATE cards SET repo_id=$2 WHERE id=$1`, [card.id, repoIds.api]);
    const { queueSpecCardTask } = await import('../src/commands/spec-card.ts');
    const { withAppendTx } = await import('../src/db/tx.ts');
    await withAppendTx(ctx().pool, async (tx) => {
      const row = (await tx.query('SELECT * FROM cards WHERE id=$1', [card.id])).rows[0];
      await queueSpecCardTask(ctx(), tx, row, { kind: 'system', id: null });
    });
    const start = await dispatch('ba');
    expect(start.baTask.specCard.chooseRepo).toBeUndefined();
    await reportFail(start, 'too vague');
    const [item] = await q(`SELECT * FROM desk_items WHERE card_id=$1 AND subkind='spec_needed'`, [card.id]);
    expect(item).toMatchObject({ pinned: true });
    r.ended(start.shiftId, 'reported');
  });
});

describe('the architect fallback', () => {
  beforeAll(async () => {
    await w.hire('Archie', 'architect', 'senior');
  });
  afterAll(async () => {
    await q(`UPDATE agents SET status='retired' WHERE role_key='architect'`);
  });

  it('takes the task when the graph is not indexed for every repository, and reads the repositories', async () => {
    await indexGraphs(['api', 'web']); // toy is not indexed
    const made = await findRepoCard('Graph does not cover everything');
    expect(made.message).toContain('sent to the architect');
    const start = await dispatch('architect');
    expect(start.baTask.specCard).toMatchObject({ chooseRepo: true, by: 'architect' });
    expect(start.readRepos.map((x: any) => x.name).sort()).toEqual(['api', 'toy', 'web']);
    const res = await report(start, { repo: 'toy', fields: fieldsFor(start, 'toy') });
    expect(res.accepted, JSON.stringify(res)).toBe(true);
    expect((await cardRow(made.card.id)).repo_id).toBe(repoIds.toy);
    r.ended(start.shiftId, 'reported');
    await indexGraphs();
  });

  it('takes the task when no BA is hired', async () => {
    await q(`UPDATE agents SET status='retired' WHERE role_key='ba'`);
    try {
      const made = await findRepoCard('No BA at all');
      expect(made.message).toContain('sent to the architect');
      const start = await dispatch('architect');
      expect(start.readRepos).toHaveLength(3);
      const res = await report(start, { repo: 'api', fields: fieldsFor(start, 'api') });
      expect(res.accepted, JSON.stringify(res)).toBe(true);
      r.ended(start.shiftId, 'reported');
    } finally {
      await q(`UPDATE agents SET status='active' WHERE role_key='ba'`);
    }
  });

  it('with neither a BA nor an architect the card stays a draft and the reply says so', async () => {
    await q(`UPDATE agents SET status='retired' WHERE role_key IN ('ba','architect')`);
    try {
      const made = await findRepoCard('Nobody to ask');
      expect(made.message).toMatch(/no BA or architect/);
      expect(await q('SELECT 1 FROM ba_tasks WHERE card_id=$1', [made.card.id])).toHaveLength(0);
    } finally {
      await q(`UPDATE agents SET status='active' WHERE role_key IN ('ba','architect')`);
    }
  });
});

describe('old runners', () => {
  it('are skipped for a scoping task; a current runner takes it', async () => {
    await q(`UPDATE workstations SET runner_version='0.1.39' WHERE id=$1`, [w.workstationId]);
    const made = await findRepoCard('Needs a new runner');
    await keepOnline(w);
    const from = r.received.length;
    expect(await baTaskPass(ctx())).toHaveLength(0);
    expect((await taskOf(made.card.id)).status).toBe('queued');
    expect(r.received.slice(from).some((f: any) => f.type === 'shift.start')).toBe(false);
    // an ordinary spec task of a card that has its repository is not held back by the old runner
    await q(`UPDATE workstations SET runner_version=$2 WHERE id=$1`, [w.workstationId, '0.1.40']);
    const start = await dispatch('ba');
    expect(start.baTask.specCard.ref).toBe(made.card.ref);
    const res = await report(start, { repo: 'api', fields: fieldsFor(start, 'api') });
    expect(res.accepted).toBe(true);
    r.ended(start.shiftId, 'reported');
  });
});

describe('patching the repository', () => {
  it('is refused once the card has a worktree or a branch', async () => {
    const card = await w.card({ title: 'Has a worktree', repoId: repoIds.api });
    const patch = (repoId: string) =>
      w.t.req('PATCH', `/api/cards/${card.id}`, { cookie: w.owner.cookie, body: { repoId } });
    await q(`UPDATE cards SET worktree_path='/tmp/wt', branch_name='aom/x' WHERE id=$1`, [card.id]);
    const res = await patch(repoIds.web);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('repo_locked');
    expect((await cardRow(card.id)).repo_id).toBe(repoIds.api);
    // naming the repository it already has is not a change
    expect((await patch(repoIds.api)).status).toBe(200);
  });
});

describe('the CEO intake', () => {
  it('sends a repo-less card to the BA and never asks for a repository', async () => {
    const ceoShift = await startCeoShift(w, r);
    const res = (await act(r, ceoShift.shiftId, 'intake', { project: 'TOY', text }, { key: 'scoping-1' }))
      .result;
    expect(res.status, JSON.stringify(res)).toBe('executed');
    expect(res.message).toContain('sent to the BA to find the repository');
    expect(res.message).not.toContain('only a person');
    expect(res.result).toMatchObject({ specified: false, baQueued: true });
    expect(await taskOf(res.result.cardId)).toMatchObject({ kind: 'spec_card', status: 'queued' });
  });
});

describe('Send to BA', () => {
  it('queues the scoping task for a draft that only lacks a repository, and refuses a complete one', async () => {
    const draft = await ok<any>(
      w.t.req('POST', '/api/cards', {
        cookie: w.owner.cookie,
        body: {
          projectId: w.projectId,
          title: 'Left as a draft',
          cardType: 'feature',
          fields: { context: text },
        },
      }),
      201,
    );
    const sent = await ok<any>(
      w.t.req('POST', `/api/cards/${draft.card.id}/send-to-ba`, { cookie: w.owner.cookie }),
    );
    expect(sent.baNotice).toContain('to find the repository');
    expect(await taskOf(draft.card.id)).toMatchObject({ status: 'queued' });
    const complete = await w.card({ title: 'Complete', repoId: repoIds.api });
    const again = await w.t.req('POST', `/api/cards/${complete.id}/send-to-ba`, { cookie: w.owner.cookie });
    expect(again.status).toBe(409);
  });
});
