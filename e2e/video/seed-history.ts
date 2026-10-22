import { randomUUID } from 'node:crypto';
import { type APIRequestContext, expect } from '@playwright/test';
import { q } from '../support/db.ts';
import { paths } from '../support/env.ts';
import { killRunner } from '../support/runner.ts';
import { createProject, hireAgent, pairWorkstation } from './seed.ts';

/**
 * Weeks of demo history for the Metrics and Costs videos. A mock run lasts minutes, so the days of finished cards,
 * shifts, token usage and costs those pages chart are written straight into their projection tables (cards,
 * card_transitions, shifts, shift_costs, agent_card_stats, test_runs). The cards themselves are created through the
 * API first, so they are real cards of the project; only their past is back-dated. Deterministic (a seeded random), so
 * a re-recording shows the same numbers. Demo data only.
 */

const DAY = 86_400_000;
const MIN = 60_000;

/** A small seeded random (mulberry32): the same history on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** USD list prices per million tokens (input, output), as the default price table: cache read x0.1, write x1.25. */
const PRICES: Record<string, [number, number]> = { opus: [5, 25], sonnet: [3, 15], haiku: [1, 5] };
export const MODELS = { opus: 'claude-opus-4-5', sonnet: 'claude-sonnet-4-5', haiku: 'claude-haiku-4-5' };

function costMicros(model: string, t: { in: number; out: number; cr: number; cw: number }): number {
  const fam = model.includes('opus') ? 'opus' : model.includes('haiku') ? 'haiku' : 'sonnet';
  const [pi, po] = PRICES[fam] as [number, number];
  return Math.round(t.in * pi + t.out * po + t.cr * pi * 0.1 + t.cw * pi * 1.25);
}

export interface HistoryAgent {
  id: string;
  name: string;
}

export interface HistoryProject {
  projectId: string;
  repoId: string;
  /** Titles of the cards finished over the range, oldest first. */
  done: string[];
  /** Cards still open now, and where they sit (`queued`/`build` is To do, `blocked` is Blocked, `draft` is Spec). */
  open: Array<{ title: string; status: 'queued' | 'blocked' | 'draft'; stage: string }>;
}

/** A feature card with a complete brief, left in Spec (seed.ts's createCard queues it for the team instead). */
async function draftCard(
  api: APIRequestContext,
  projectId: string,
  repoId: string,
  title: string,
): Promise<void> {
  const r = await api.post('/api/cards', {
    data: {
      projectId,
      title,
      cardType: 'feature',
      repoId,
      completionAction: 'pr',
      fields: {
        context: 'Demo context.',
        requirements: title,
        acceptanceCriteria: ['It works', 'It is visible'],
        affectedAreas: 'index.js',
        constraints: 'None',
        testPlan: 'Open the page',
      },
      specify: false,
    },
  });
  expect(r.status(), await r.text()).toBe(201);
}

async function insertShift(s: {
  orgId: string;
  agentId: string;
  workstationId: string;
  projectId: string | null;
  cardId: string | null;
  kind: 'card' | 'chat';
  costKind?: string;
  stage: string | null;
  model: string;
  start: Date;
  minutes: number;
  tokens: { in: number; out: number; cr: number; cw: number };
}): Promise<number> {
  const id = randomUUID();
  const end = new Date(s.start.getTime() + s.minutes * MIN);
  const cost = costMicros(s.model, s.tokens);
  await q(
    `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, stage, status, outcome, runtime, model,
                         started_at, ended_at, duration_ms, tokens_input, tokens_output, tokens_cache_read,
                         tokens_cache_write, project_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ended','completed','claude-code',$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id,
      s.orgId,
      s.agentId,
      s.workstationId,
      s.cardId,
      s.kind,
      s.stage,
      s.model,
      s.start,
      end,
      s.minutes * MIN,
      s.tokens.in,
      s.tokens.out,
      s.tokens.cr,
      s.tokens.cw,
      s.cardId ? null : s.projectId,
    ],
  );
  await q(
    `INSERT INTO shift_costs (shift_id, org_id, agent_id, project_id, card_id, kind, model, tokens_input, tokens_output,
                              tokens_cache_read, tokens_cache_write, cost_usd_micros, ended_at, cost_stamped)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)`,
    [
      id,
      s.orgId,
      s.agentId,
      s.projectId,
      s.cardId,
      s.costKind ?? s.kind,
      s.model,
      s.tokens.in,
      s.tokens.out,
      s.tokens.cr,
      s.tokens.cw,
      cost,
      end,
    ],
  );
  return cost;
}

/**
 * Writes `days` days of finished work for each project: per finished card a build, review and test shift (sometimes
 * a rework round, a failed test or a wait on the Owner), the costs of every shift, the builder's card stats and the
 * test runs; the open cards are moved to their columns. `overhead` adds BA chats outside any project, `ceo` the CEO's
 * own chats (the Management row of Costs).
 */
export async function seedHistory(
  api: APIRequestContext,
  o: {
    workstationId: string;
    projects: HistoryProject[];
    builders: HistoryAgent[];
    reviewer: HistoryAgent;
    tester: HistoryAgent;
    ba?: HistoryAgent;
    ceo?: HistoryAgent;
    days?: number;
    seed?: number;
  },
): Promise<void> {
  const days = o.days ?? 30;
  const rand = rng(o.seed ?? 7);
  const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
  const int = (lo: number, hi: number) => Math.round(between(lo, hi));
  const now = Date.now();
  const [org] = await q<{ org_id: string }>('SELECT org_id FROM projects WHERE id=$1', [
    o.projects[0]?.projectId,
  ]);
  const orgId = org?.org_id as string;
  expect(orgId).toBeTruthy();

  for (const [pi, p] of o.projects.entries()) {
    for (const title of [...p.done, ...p.open.map((x) => x.title)])
      await draftCard(api, p.projectId, p.repoId, title);
    const ids = new Map(
      (
        await q<{ id: string; title: string }>('SELECT id, title FROM cards WHERE project_id=$1', [
          p.projectId,
        ])
      ).map((r) => [r.title, r.id]),
    );

    for (const [i, title] of p.done.entries()) {
      const cardId = ids.get(title) as string;
      // spread over the range, oldest first, with a few busier days
      const dayAgo = Math.max(
        0,
        Math.floor(((p.done.length - 1 - i) * (days - 1)) / Math.max(1, p.done.length - 1)),
      );
      const finalized = new Date(now - dayAgo * DAY - between(1, 7) * 3_600_000);
      const created = new Date(finalized.getTime() - between(0.6, 3.5) * DAY);
      const builder = o.builders[(i + pi) % o.builders.length] as HistoryAgent;
      const rework = rand() < 0.22;
      const testFail = !rework && rand() < 0.15;
      const blocked = rand() < 0.3;
      const span = finalized.getTime() - created.getTime();
      let t = created.getTime() + span * 0.1;
      const step = (frac: number) => {
        const at = new Date(t);
        t += span * frac;
        return at;
      };
      const big = rand() < 0.35;
      const buildModel = big ? MODELS.opus : MODELS.sonnet;
      const tok = (scale: number) => ({
        in: Math.round(int(30_000, 110_000) * scale),
        out: Math.round(int(6_000, 24_000) * scale),
        cr: Math.round(int(250_000, 900_000) * scale),
        cw: Math.round(int(20_000, 70_000) * scale),
      });

      if (blocked) {
        const at = new Date(created.getTime() + span * 0.05);
        const until = new Date(at.getTime() + between(1.5, 9) * 3_600_000);
        for (const [to, when] of [
          ['blocked', at],
          ['queued', until],
        ] as const)
          await q(
            `INSERT INTO card_transitions (card_id, from_stage, to_stage, from_status, to_status, reason, event_seq, at)
             VALUES ($1,'build','build',$2,$3,$4,0,$5)`,
            [
              cardId,
              to === 'blocked' ? 'queued' : 'blocked',
              to,
              to === 'blocked' ? 'question for the Owner' : 'answered',
              when,
            ],
          );
        t = until.getTime();
      }
      await insertShift({
        orgId,
        agentId: builder.id,
        workstationId: o.workstationId,
        projectId: p.projectId,
        cardId,
        kind: 'card',
        stage: 'build',
        model: buildModel,
        start: step(0.25),
        minutes: int(18, 55),
        tokens: tok(1),
      });
      if (rework) {
        await insertShift({
          orgId,
          agentId: o.reviewer.id,
          workstationId: o.workstationId,
          projectId: p.projectId,
          cardId,
          kind: 'card',
          stage: 'review',
          model: MODELS.sonnet,
          start: step(0.1),
          minutes: int(6, 14),
          tokens: tok(0.4),
        });
        await insertShift({
          orgId,
          agentId: builder.id,
          workstationId: o.workstationId,
          projectId: p.projectId,
          cardId,
          kind: 'card',
          stage: 'build',
          model: buildModel,
          start: step(0.15),
          minutes: int(10, 30),
          tokens: tok(0.6),
        });
      }
      await insertShift({
        orgId,
        agentId: o.reviewer.id,
        workstationId: o.workstationId,
        projectId: p.projectId,
        cardId,
        kind: 'card',
        stage: 'review',
        model: MODELS.sonnet,
        start: step(0.1),
        minutes: int(6, 15),
        tokens: tok(0.4),
      });
      if (testFail) {
        const failAt = step(0.1);
        await insertShift({
          orgId,
          agentId: o.tester.id,
          workstationId: o.workstationId,
          projectId: p.projectId,
          cardId,
          kind: 'card',
          stage: 'test',
          model: MODELS.haiku,
          start: failAt,
          minutes: int(8, 18),
          tokens: tok(0.5),
        });
        await q(
          `INSERT INTO test_runs (card_id, kind, platform, result, event_seq, created_at) VALUES ($1,'feature','web','failed',0,$2)`,
          [cardId, new Date(failAt.getTime() + 15 * MIN)],
        );
        await insertShift({
          orgId,
          agentId: builder.id,
          workstationId: o.workstationId,
          projectId: p.projectId,
          cardId,
          kind: 'card',
          stage: 'build',
          model: buildModel,
          start: step(0.1),
          minutes: int(8, 25),
          tokens: tok(0.5),
        });
      }
      const testAt = step(0.1);
      await insertShift({
        orgId,
        agentId: o.tester.id,
        workstationId: o.workstationId,
        projectId: p.projectId,
        cardId,
        kind: 'card',
        stage: 'test',
        model: MODELS.haiku,
        start: testAt,
        minutes: int(8, 20),
        tokens: tok(0.5),
      });
      await q(
        `INSERT INTO test_runs (card_id, kind, platform, result, event_seq, created_at) VALUES ($1,'feature','web','passed',0,$2)`,
        [cardId, new Date(testAt.getTime() + 15 * MIN)],
      );
      await q(
        `INSERT INTO agent_card_stats (agent_id, card_id, org_id, project_id, role_key, first_at, last_at, done_at, submitted,
                                       rework_rounds, bugs, shift_ms)
         VALUES ($1,$2,$3,$4,'builder',$5,$6,$6,true,$7,$8,$9)`,
        [
          builder.id,
          cardId,
          orgId,
          p.projectId,
          created,
          finalized,
          rework ? 1 : 0,
          testFail ? 1 : 0,
          int(20, 80) * MIN,
        ],
      );
      await q(
        `UPDATE cards SET status='done', stage='done', created_at=$2, finalized_at=$3, updated_at=$3,
                last_agent_id=$4, original_builder_agent_id=$4, rework_round=$5 WHERE id=$1`,
        [cardId, created, finalized, builder.id, rework ? 1 : 0],
      );
      await q('UPDATE card_transitions SET at=$2 WHERE card_id=$1 AND at > $2 AND event_seq <> 0', [
        cardId,
        created,
      ]);
      await q(
        `INSERT INTO card_transitions (card_id, from_stage, to_stage, from_status, to_status, reason, event_seq, at)
         VALUES ($1,'finalize','done','claimed','done','finalized',0,$2)`,
        [cardId, finalized],
      );
    }

    for (const c of p.open) {
      const cardId = ids.get(c.title) as string;
      const since = new Date(now - between(2, 20) * 3_600_000);
      await q(
        `UPDATE cards SET status=$2, stage=$3, created_at=$4, updated_at=$4, queued_at=$5, blocked_since=$6 WHERE id=$1`,
        [
          cardId,
          c.status,
          c.stage,
          since,
          c.status === 'draft' ? null : since,
          c.status === 'blocked' ? since : null,
        ],
      );
    }
  }

  // BA chats outside a project (org overhead) and the CEO's own chats (management), every few days
  for (let d = days - 2; d >= 0; d -= 3) {
    const start = new Date(now - d * DAY - between(2, 9) * 3_600_000);
    if (o.ba)
      await insertShift({
        orgId,
        agentId: o.ba.id,
        workstationId: o.workstationId,
        projectId: null,
        cardId: null,
        kind: 'chat',
        stage: null,
        model: MODELS.sonnet,
        start,
        minutes: int(5, 15),
        tokens: { in: int(20_000, 60_000), out: int(3_000, 9_000), cr: int(100_000, 300_000), cw: 10_000 },
      });
    if (o.ceo)
      await insertShift({
        orgId,
        agentId: o.ceo.id,
        workstationId: o.workstationId,
        projectId: null,
        cardId: null,
        kind: 'chat',
        costKind: 'ceo_chat',
        stage: null,
        model: MODELS.opus,
        start: new Date(start.getTime() + 3_600_000),
        minutes: int(4, 12),
        tokens: { in: int(20_000, 50_000), out: int(2_000, 6_000), cr: int(80_000, 250_000), cw: 8_000 },
      });
  }
}

/** This month's spend of a project in USD micros (the budget meter's numerator, at a rate of 1). */
export async function monthSpendMicros(projectId: string): Promise<number> {
  const [r] = await q<{ usd: string | null }>(
    `SELECT sum(cost_usd_micros)::text AS usd FROM shift_costs
      WHERE project_id=$1 AND ended_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [projectId],
  );
  return Number(r?.usd ?? 0);
}

const SHOP_DONE = [
  'Product search box',
  'Filter products by size',
  'Sort products by price',
  'Show stock on product pages',
  'Customer reviews on product pages',
  'Star rating summary',
  'Order confirmation email',
  'Shipping cost calculator',
  'Guest checkout',
  'Save the cart between visits',
  'Discount codes at checkout',
  'Gift wrapping option',
  'Wishlist for returning customers',
  'Recently viewed products',
  'Fix the cart total rounding',
  'Fix broken images on mobile',
  'Order history page',
  'Reorder from order history',
  'Invoice download as PDF',
  'Newsletter sign-up in the footer',
  'Size guide pop-up',
  'Related products row',
  'Faster product image loading',
  'Address autocomplete',
  'Low stock warning for the shop team',
  'Return request form',
  'Track my parcel page',
  'Accessible colour contrast on buttons',
];
const SHOP_OPEN: HistoryProject['open'] = [
  { title: 'Pay in three instalments', status: 'queued', stage: 'build' },
  { title: 'Product comparison table', status: 'queued', stage: 'build' },
  { title: 'Gift cards', status: 'queued', stage: 'review' },
  { title: 'Store pickup option', status: 'queued', stage: 'test' },
  { title: 'Loyalty points', status: 'blocked', stage: 'build' },
  { title: 'Live chat with the shop team', status: 'draft', stage: 'spec' },
];
const BLOG_DONE = [
  'Article page layout',
  'Author pages',
  'Tags on articles',
  'Search the blog',
  'RSS feed',
  'Reading time on articles',
  'Share buttons',
  'Comment moderation queue',
  'Related articles',
  'Fix dates in the archive',
  'Dark mode for articles',
  'Newsletter archive',
  'Image captions',
  'Table of contents for long articles',
  'Draft preview links',
  'Scheduled publishing',
];
const BLOG_OPEN: HistoryProject['open'] = [
  { title: 'Podcast episodes page', status: 'queued', stage: 'build' },
  { title: 'Series of articles', status: 'queued', stage: 'review' },
  { title: 'Translate articles', status: 'draft', stage: 'spec' },
];

/**
 * The demo history of Metrics and Costs: projects "Web shop" (SHOP) and "Company blog" (BLOG), a mock workstation
 * (switched off once the agents are hired, so nobody picks up the open cards while the camera rolls), two builders, a
 * reviewer, a tester, a BA and (with `ceo`) a CEO, and 30 days of finished work.
 */
export async function seedDemoHistory(
  api: APIRequestContext,
  opts: { ceo?: boolean } = {},
): Promise<{ shop: string; blog: string }> {
  const shop = await createProject(api, 'SHOP', 'Web shop');
  const blog = await createProject(api, 'BLOG', 'Company blog', { repo: 'blog' });
  const workstationId = await pairWorkstation(api);
  // every built-in role offers senior; some (the reviewer, for example) only that
  const agent = async (name: string, roleKey: string, seniority = 'junior') => {
    await hireAgent(api, { name, roleKey, workstationId, seniority });
    // the hire answer does not carry the id in the shape seed.ts expects: read it back
    const [row] = await q<{ id: string }>('SELECT id FROM agents WHERE name=$1 AND role_key=$2', [
      name,
      roleKey,
    ]);
    expect(row, `agent ${name}`).toBeTruthy();
    return { id: (row as { id: string }).id, name };
  };
  const builders = [await agent('Noah', 'builder'), await agent('Mia', 'builder', 'senior')];
  const reviewer = await agent('Leo', 'reviewer', 'senior');
  const tester = await agent('Ava', 'tester', 'senior');
  const ba = await agent('Ivy', 'ba', 'senior');
  // the CEO is built in (every organization has one): its chats are the Management row of Costs
  const [ceoRow] = opts.ceo
    ? await q<{ id: string; name: string }>(
        `SELECT a.id, a.name FROM agents a JOIN projects p ON p.org_id = a.org_id
          WHERE p.id=$1 AND a.role_key='ceo' AND a.status <> 'retired' LIMIT 1`,
        [shop.projectId],
      )
    : [];
  if (opts.ceo) expect(ceoRow, 'the built-in CEO').toBeTruthy();
  const ceo = ceoRow ? { id: ceoRow.id, name: ceoRow.name } : undefined;
  killRunner('SIGKILL', paths.runnerHome('video'));
  await seedHistory(api, {
    workstationId,
    builders,
    reviewer,
    tester,
    ba,
    ...(ceo ? { ceo } : {}),
    projects: [
      { projectId: shop.projectId, repoId: shop.repoId as string, done: SHOP_DONE, open: SHOP_OPEN },
      { projectId: blog.projectId, repoId: blog.repoId as string, done: BLOG_DONE, open: BLOG_OPEN },
    ],
  });
  return { shop: shop.projectId, blog: blog.projectId };
}
