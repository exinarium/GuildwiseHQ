import type { FastifyInstance } from 'fastify';
import { createSession, deleteSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { sha256Hex } from '../crypto.ts';
import { one } from '../db/sql.ts';
import { conflict } from '../errors.ts';

export interface DemoSummary {
  projects: number;
  agents: number;
  cards: number;
  deskQuestions: number;
  schedules: number;
  note: string;
}

const FIELDS = (extra: Record<string, unknown> = {}) => ({
  context: 'Customers asked for this in the last round of feedback.',
  requirements: 'Implement the change described in the title and keep the existing behaviour working.',
  acceptanceCriteria: ['It works as described', 'Existing tests still pass'],
  affectedAreas: 'src/',
  constraints: 'No new dependencies.',
  testPlan: 'Run the test suite and try the change by hand.',
  ...extra,
});

const PROJECTS = [
  {
    key: 'SHOP',
    name: 'Online Shop',
    repo: { name: 'shop', url: 'https://github.com/acme/shop.git' },
    cards: [
      ['Add a gift-wrap option at checkout', 'feature', 2],
      ['Show delivery estimates on the product page', 'feature', 3],
      ['Fix the basket total when a coupon is removed', 'bug', 1],
      ['Send an order confirmation email', 'feature', 4],
    ],
    question: ['Add saved addresses to the account page', 'build'],
  },
  {
    key: 'APP',
    name: 'Mobile App',
    repo: { name: 'app', url: 'https://github.com/acme/app.git' },
    cards: [
      ['Dark mode for the settings screen', 'feature', 3],
      ['Offline mode for the order history', 'feature', 2],
      ['Crash when rotating the checkout screen', 'bug', 1],
    ],
    question: ['Push notifications for order updates', 'review'],
  },
] as const;

const TEAM = [
  ['Alice', 'builder', 'junior'],
  ['Ben', 'builder', 'senior'],
  ['Rae', 'reviewer', 'senior'],
  ['Tess', 'tester', 'junior'],
] as const;

/**
 * Fills an EMPTY simulation organization with a busy company, like the getting-started video: two projects with local
 * repositories, a hired team per project and a business analyst, cards at different priorities (a few start with a
 * scripted desk question, one stays a draft) and a schedule. It drives the same API a person would, as the Owner, so
 * every rule applies. Refuses (409) when the organization already has a project: it never mixes into existing work.
 */
export async function loadDemoScenario(ctx: Ctx, app: FastifyInstance, orgId: string): Promise<DemoSummary> {
  const org = await one(ctx.pool, 'SELECT owner_user_id, simulation FROM organizations WHERE id=$1', [orgId]);
  if (!org?.simulation)
    throw conflict('not_simulation', 'the demo scenario can only be loaded into a simulation organization');
  if (await one(ctx.pool, 'SELECT 1 FROM projects WHERE org_id=$1', [orgId]))
    throw conflict(
      'demo_not_empty',
      'this organization already has projects: the demo scenario is only loaded into an empty one',
    );
  const sim = ctx.services.simulation;
  if (!sim) throw conflict('simulation_unavailable', 'simulation hosting is switched off on this server');
  sim.reconcile(orgId);
  await sim.ready(orgId);
  const ws = await one<{ id: string }>(
    ctx.pool,
    `SELECT id FROM workstations WHERE simulation_org_id=$1 AND status='active' ORDER BY paired_at LIMIT 1`,
    [orgId],
  );
  if (!ws)
    throw conflict(
      'simulation_workstation_missing',
      `the simulated workstation is not available${sim.status(orgId).detail ? `: ${sim.status(orgId).detail}` : ''}`,
    );

  const { token } = await createSession(ctx, org.owner_user_id, { userAgent: 'demo-scenario' });
  const headers = { cookie: `aom_sid=${token}`, origin: ctx.config.publicOrigin, 'x-aom-org': orgId };
  const call = async <T = any>(method: 'POST', url: string, body: unknown, want = 201): Promise<T> => {
    const res = await app.inject({ method, url, headers, payload: body as object });
    if (res.statusCode !== want)
      throw conflict('demo_failed', `${method} ${url} answered ${res.statusCode}: ${res.body.slice(0, 300)}`);
    return (res.body ? JSON.parse(res.body) : undefined) as T;
  };
  const out: DemoSummary = { projects: 0, agents: 0, cards: 0, deskQuestions: 0, schedules: 0, note: '' };
  try {
    const hire = async (name: string, roleKey: string, seniority: string, allowed: string[] | null) => {
      await call('POST', '/api/agents', {
        name,
        roleKey,
        seniority,
        workstationId: ws.id,
        runtime: 'mock',
        model: 'mock',
        allowedProjectIds: allowed,
      });
      out.agents++;
    };
    const projectIds: string[] = [];
    for (const p of PROJECTS) {
      const created = await call('POST', '/api/projects', { key: p.key, name: p.name });
      const projectId = created.project.id as string;
      projectIds.push(projectId);
      out.projects++;
      await call('POST', `/api/projects/${projectId}/repos`, { name: p.repo.name, remoteUrl: p.repo.url });
      for (const [name, roleKey, seniority] of TEAM)
        await hire(`${name} (${p.key})`, roleKey, seniority, [projectId]);
      for (const [title, cardType, priority] of p.cards) {
        await call('POST', '/api/cards', {
          projectId,
          title,
          cardType,
          fields: FIELDS(),
          priority,
          completionAction: 'merge',
          specify: true,
        });
        out.cards++;
      }
      // A card whose builder (or reviewer) asks a question on the desk, scripted by the mock agent.
      const [qTitle, qStage] = p.question;
      await call('POST', '/api/cards', {
        projectId,
        title: qTitle,
        cardType: 'feature',
        fields: FIELDS({ mock: { [qStage]: ['question', 'ok'] } }),
        priority: 2,
        completionAction: 'merge',
        specify: true,
      });
      out.cards++;
      out.deskQuestions++;
      // One idea that is not specified yet.
      await call('POST', '/api/cards', {
        projectId,
        title: `Idea: ${p.name} loyalty points`,
        cardType: 'feature',
        fields: {},
        priority: 5,
        specify: false,
      });
      out.cards++;
    }
    await hire('Bailey', 'ba', 'senior', null);
    await call('POST', '/api/schedules', {
      projectId: projectIds[0],
      name: 'Weekly dependency check',
      kind: 'card',
      cron: '0 7 * * 1',
      timezone: 'Africa/Johannesburg',
      cardTemplate: { title: 'Check dependencies for updates', fields: FIELDS() },
    });
    out.schedules++;
    out.note =
      'Added two projects with local repositories, a team for each, cards, desk questions and a schedule.';
  } finally {
    await deleteSession(ctx, sha256Hex(token));
  }
  ctx.services.dispatcher.trigger();
  return out;
}
