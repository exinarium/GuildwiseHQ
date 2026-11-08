import {
  RELEASE_CHANGELOG_OUTCOME,
  RELEASE_DOCS_PREP_CAPABILITY,
  RELEASE_DOCS_PREP_CHANGELOG_CAPABILITY,
  RELEASE_SHIP_CAPABILITY,
  ReleaseFactsSchema,
} from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withAppendTx } from '../src/db/tx.ts';
import { applyReleaseDocsPrepResult } from '../src/release/docs-prep.ts';
import {
  applyReleaseChangelogReport,
  buildReleaseChangelogTask,
} from '../src/release/docs-prep-changelog-task.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, fullFields, markOnline, type World } from './helpers/world.ts';

/** 'Write changelog' for intake cards: the writer sees the ticket, and the accepted entry names it, never the card key. */

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const HEAD = 'a'.repeat(40);
const M1 = 'c'.repeat(40);
const M2 = 'd'.repeat(40);
const M3 = 'e'.repeat(40);
const q2 = async (sql: string, params: unknown[] = []) => (await q(sql, params)) as [any, ...any[]];
const base = () => `/api/projects/${w.projectId}/release-docs-prep`;
const cmds = () => q2(`SELECT * FROM runner_commands WHERE type='release.docs_prep' ORDER BY created_at`);
const tasks = () => q2(`SELECT * FROM ba_tasks WHERE kind='release_changelog' ORDER BY created_at`);

beforeEach(async () => {
  await freshState();
  await q(`TRUNCATE release_proposals, release_ships, repo_release_facts, release_docs_prep_runs CASCADE`);
  await q(`TRUNCATE runner_commands CASCADE`);
  await q(`DELETE FROM ba_tasks WHERE kind='release_changelog'`);
  await q(
    `UPDATE projects SET release_docs_prep='{"enabled": true, "steps": {"guide": false}}'::jsonb, working_branch='release/1.5.0' WHERE id=$1`,
    [w.projectId],
  );
  await q(`UPDATE project_repos SET main_branch='main', working_branch=NULL WHERE id=$1`, [w.repoId]);
  await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
  await q(
    `INSERT INTO workstation_capabilities (workstation_id, capabilities, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (workstation_id) DO UPDATE SET capabilities=$2`,
    [
      w.workstationId,
      [RELEASE_DOCS_PREP_CAPABILITY, RELEASE_SHIP_CAPABILITY, RELEASE_DOCS_PREP_CHANGELOG_CAPABILITY],
    ],
  );
  const facts = ReleaseFactsSchema.parse({
    headSha: HEAD,
    ahead: 3,
    lastTag: { name: 'v1.3.0', sha: 'b'.repeat(40) },
    existingTags: ['v1.3.0'],
    changedTotal: 1,
    commits: [],
    components: [],
    changelog: '## [Unreleased]\n\n## [1.3.0] - 2026-10-20\n',
  });
  await q(
    `INSERT INTO repo_release_facts (project_repo_id, request_id, trigger, state, head_sha, facts, requested_at, updated_at)
     VALUES ($1, gen_random_uuid(), 'manual', 'ready', $2, $3::jsonb, now(), now())
     ON CONFLICT (project_repo_id) DO UPDATE SET state='ready', head_sha=$2, facts=$3::jsonb`,
    [w.repoId, HEAD, JSON.stringify(facts)],
  );
});

async function analyse(merges: Array<{ sha: string; subject: string; cardKeys: string[] }>) {
  expect((await w.t.req('POST', `${base()}/runs`, { cookie: w.owner.cookie })).status).toBeLessThan(300);
  const list = await cmds();
  const last = list[list.length - 1];
  await applyReleaseDocsPrepResult(
    w.t.app.ctx,
    w.workstationId,
    last.payload,
    true,
    {
      ok: true,
      state: 'passed',
      files: [],
      notices: [],
      baseTag: 'v1.3.0',
      baseSha: 'b'.repeat(40),
      headSha: HEAD,
      summary: {
        repoName: 'toy',
        branch: 'release/1.5.0',
        headSha: HEAD,
        base: { kind: 'tag', tag: 'v1.3.0', sha: 'b'.repeat(40) },
        commitCount: merges.length,
        commits: [],
        commitsTruncated: false,
        merges: merges.map((m) => ({ ...m, prNumber: null })),
        cards: [],
        areas: [],
      },
    },
    undefined,
  );
}

const ENTRY = (what: string) =>
  `${what}. Download every card of a board as a spreadsheet to share it with people outside the team.`;

describe('Write changelog for intake cards', () => {
  it('maps the internal key and the ticket of an intake card to the ticket, and adds it to the accepted entry', async () => {
    const intake = await w.card({ title: 'Export boards', fields: fullFields({ externalRef: 'abc-1' }) });
    const plain = await w.card({ title: 'Faster board', fields: fullFields({}) });
    await analyse([
      { sha: M1, subject: `Merge ${intake.ref} export boards`, cardKeys: [intake.ref] },
      { sha: M2, subject: 'Merge ABC-1 export boards, part 2', cardKeys: ['ABC-1'] },
      { sha: M3, subject: `Merge ${plain.ref}`, cardKeys: [plain.ref] },
    ]);
    const [task] = await tasks();
    const brief = await buildReleaseChangelogTask(w.t.app.ctx.pool, task);
    expect(brief?.changes.map((c) => c.cards)).toEqual([
      [{ key: 'ABC-1', title: 'Export boards', client: true }],
      [{ key: 'ABC-1', title: 'Export boards', client: true }],
      [{ key: plain.ref, title: 'Faster board' }],
    ]);
    expect(JSON.stringify(brief)).not.toContain(intake.ref);
    expect(brief?.changes[0]?.subject).toBe('Merge ABC-1 export boards');

    await q(`UPDATE ba_tasks SET status='running' WHERE id=$1`, [task.id]);
    const res = await withAppendTx(w.t.app.ctx.pool, (tx) =>
      applyReleaseChangelogReport(w.t.app.ctx, tx, task, {
        report: {
          kind: 'outcome',
          outcomeId: RELEASE_CHANGELOG_OUTCOME.done,
          data: {
            entries: [
              { heading: 'Added', text: ENTRY('Export a board'), sources: [M1, M2] },
              { heading: 'Changed', text: ENTRY('Faster board'), sources: [M3] },
            ],
          },
        },
      } as any),
    );
    expect(res.accepted).toBe(true);
    const list = await cmds();
    const sent = list[list.length - 1].payload;
    expect(sent.step).toBe('changelog');
    expect(sent.changelog.entries.map((e: any) => e.text)).toEqual([
      `${ENTRY('Export a board')} (ABC-1)`,
      ENTRY('Faster board'),
    ]);
    expect(JSON.stringify(sent.changelog.entries)).not.toContain(intake.ref);
  });
});
