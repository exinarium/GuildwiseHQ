import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAdapter } from '../src/adapters/mock.ts';
import { MockRuntimeConfigSchema } from '../src/config.ts';
import { describeDrafts, type OrgRouteData, routeRequest } from '../src/graph/org.ts';
import { runnerPaths } from '../src/paths.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const SHOP = 'p-shop';
const BILL = 'p-bill';
const SITE = 'p-site';
const OLD = 'p-old';

const data = (over: Partial<OrgRouteData> = {}): OrgRouteData => ({
  projects: [
    { id: SHOP, key: 'SHOP', name: 'Web shop', retired: false },
    { id: BILL, key: 'BILL', name: 'Billing', retired: false },
    { id: SITE, key: 'SITE', name: 'Docs site', retired: false },
    { id: OLD, key: 'OLD', name: 'Old invoicing system', retired: true },
  ],
  modules: [
    { projectId: SHOP, repoKey: 'a', dir: 'apps/checkout', pkg: '@acme/checkout' },
    { projectId: SHOP, repoKey: 'a', dir: 'services/invoicing' },
    { projectId: BILL, repoKey: 'b', dir: 'packages/billing-client', pkg: '@acme/billing-client' },
    { projectId: BILL, repoKey: 'b', dir: 'services/invoicing' },
    { projectId: SITE, repoKey: 'c', dir: 'site' },
    { projectId: OLD, repoKey: 'd', dir: 'services/invoicing' },
  ],
  derived: [],
  assertions: [],
  ...over,
});

describe('aom ceo route: candidates with reasons (design sections 7 and 8)', () => {
  it('ranks projects by name and by area, with the reason for each', () => {
    const t = routeRequest(data(), 'fix the checkout total');
    expect(t.split('\n')[0]).toBe('1. SHOP Web shop: area apps/checkout matches "checkout"');
    const t2 = routeRequest(data(), 'billing client retries');
    expect(t2.split('\n')[0]).toMatch(
      /^1\. BILL Billing: its name matches "billing"; area packages\/billing-client matches "billing client"/,
    );
    expect(t).toContain('(a ranking, not a decision)');
  });

  it('is deterministic: the same request and graph always give the same answer; ties fall back to the project name', () => {
    const a = routeRequest(data(), 'invoicing');
    expect(routeRequest(data(), 'invoicing')).toBe(a);
    expect(
      a
        .split('\n')
        .slice(0, 2)
        .map((l) => l.split(':')[0]),
    ).toEqual(['1. BILL Billing', '2. SHOP Web shop']);
  });

  it('never routes to a retired project, however well it matches', () => {
    const t = routeRequest(data(), 'old invoicing system');
    expect(t).not.toContain('OLD');
    expect(t).toContain('BILL');
    // even when the owner linked it
    const linked = routeRequest(
      data({ assertions: [{ from: { project: OLD }, to: { project: BILL }, kind: 'depends_on' }] }),
      'old system',
    );
    expect(linked).not.toContain('OLD');
  });

  it('a link the code suggests does not count until the owner accepted it; links the owner asserted do', () => {
    const base = data({
      derived: [
        { from: SHOP, to: SITE, kind: 'depends_on', conf: 'EXTRACTED', status: 'draft', evidence: ['x'] },
      ],
    });
    expect(routeRequest(base, 'checkout')).not.toContain('SITE');
    const accepted = data({
      derived: [
        { from: SHOP, to: SITE, kind: 'depends_on', conf: 'EXTRACTED', status: 'accepted', evidence: ['x'] },
      ],
    });
    expect(routeRequest(accepted, 'checkout')).toContain('SITE Docs site: SHOP depends on it (accepted)');
    const asserted = data({ assertions: [{ from: { project: SHOP }, to: { project: BILL }, kind: 'uses' }] });
    expect(routeRequest(asserted, 'checkout')).toContain('BILL Billing: linked to SHOP (as the owner said)');
  });

  it('a name the owner typed in a link points to the projects linked to it', () => {
    const d = data({
      assertions: [{ from: { project: SITE }, to: { name: 'status-page.example' }, kind: 'uses' }],
    });
    expect(routeRequest(d, 'update the status page')).toContain(
      'SITE Docs site: linked to "status-page.example" (as the owner said)',
    );
  });

  it('answers in at most 800 bytes, and says so when nothing matches or nothing was asked', () => {
    const many = data({
      projects: Array.from({ length: 12 }, (_, i) => ({
        id: `p${i}`,
        key: `K${i}`,
        name: `Checkout service number ${i} ${'very long name '.repeat(8)}`,
        retired: false,
      })),
    });
    const t = routeRequest(many, 'checkout service');
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(800);
    expect(routeRequest(data(), 'zebra giraffe')).toMatch(/No project or area/);
    expect(routeRequest(data(), 'the and of')).toMatch(/Say what the request is about/);
  });
});

describe('aom ceo route --drafts: what the code suggests, for the CEO to show in chat', () => {
  const draft = (
    from: string,
    to: string,
    kind: 'depends_on' | 'touches',
    status: 'draft' | 'accepted' = 'draft',
  ) => ({
    from,
    to,
    kind,
    conf: kind === 'depends_on' ? ('EXTRACTED' as const) : ('INFERRED' as const),
    status,
    evidence: [
      kind === 'depends_on'
        ? 'apps/checkout declares @acme/billing-client, which is packages/billing-client'
        : 'both have an area named invoicing',
    ],
  });

  it('lists the drafts between live projects with their evidence, tagged, and leaves out accepted ones and retired projects', () => {
    const t = describeDrafts(
      data({
        derived: [
          draft(SHOP, BILL, 'depends_on'),
          draft(SHOP, BILL, 'touches'),
          draft(SHOP, SITE, 'depends_on', 'accepted'),
          draft(SHOP, OLD, 'touches'),
        ],
      }),
    );
    expect(t).toContain('Links the code suggests (drafts: not decided, not used for routing)');
    expect(t).toContain(
      '- SHOP Web shop depends on BILL Billing [E]: apps/checkout declares @acme/billing-client',
    );
    expect(t).toContain(
      '- SHOP Web shop shares an area with BILL Billing [I]: both have an area named invoicing',
    );
    expect(t).not.toContain('SITE');
    expect(t).not.toContain('OLD');
  });

  it('says so when there are none, and stays inside its size', () => {
    expect(describeDrafts(data())).toMatch(/suggests no links/);
    const many = Array.from({ length: 80 }, (_, i) => ({
      ...draft(SHOP, BILL, 'touches'),
      evidence: [`both have an area named area${i} ${'x'.repeat(40)}`],
    }));
    expect(Buffer.byteLength(describeDrafts(data({ derived: many })))).toBeLessThanOrEqual(1900);
  });
});

describe('aom ceo route in the CEO chat: read-only, from the organization vault on this workstation', () => {
  const ORG_VAULT = '019e3f6a-7b1c-7a2d-8c3e-0123456789d9';
  const ceoRole = BUILTIN_ROLES.find((r) => r.key === 'ceo') ?? BUILTIN_ROLES[0];

  async function chat(
    roleKey: 'ceo' | 'builder',
    orgGraph: Record<string, unknown> | undefined,
    withFiles = true,
  ) {
    const results: Record<string, any> = {};
    const mock = new MockAdapter(MockRuntimeConfigSchema.parse({ enabled: true }), runnerPaths(tmp()));
    const adapter = Object.assign(Object.create(mock), {
      id: 'mock',
      capabilities: () => mock.capabilities(),
      startChat: async (input: { env: Record<string, string> }) => {
        const post = async (method: string, params: Record<string, unknown>) =>
          (
            await fetch(`${input.env.AOM_IPC_URL}/v1/rpc`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${input.env.AOM_SHIFT_TOKEN}`,
              },
              body: JSON.stringify({ method, params }),
            })
          ).json();
        results.route = await post('ceo', { op: 'route', q: 'fix the checkout total' });
        results.drafts = await post('ceo', { op: 'route', drafts: true });
        results.empty = await post('ceo', { op: 'route' });
        results.snapshot = await post('ceo', { op: 'snapshot' });
        return mock.startChat(input as never);
      },
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter as never]]) });
    h.runner.vaults.configure({
      vaults: [
        {
          vaultId: ORG_VAULT,
          kind: 'org',
          name: 'Org',
          remoteUrl: '',
          syncIntervalSec: 300,
          storage: 'local',
        },
      ],
      identity: { name: 'A', email: 'a@agents.aom.invalid' },
      workstationName: 'Desk',
      resume: [],
    });
    if (withFiles) {
      const dir = join(h.runner.vaults.dir(ORG_VAULT), 'org', 'graph');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), '{}');
      writeFileSync(
        join(dir, 'projects.jsonl'),
        `${JSON.stringify({ t: 'p', id: SHOP, key: 'SHOP', name: 'Web shop', retired: false })}\n${JSON.stringify({ t: 'm', p: SHOP, repo: 'a', dir: 'apps/checkout' })}\n`,
      );
    }
    const chatId = uuidv7();
    h.server.send('chat.start', {
      chatId,
      threadId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
      agent: {
        agentId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
        name: 'Cleo',
        roleKey,
        seniority: 'senior',
        runtime: 'mock',
        model: 'mock',
        skills: [],
        permissions: ceoRole?.permissions,
        isDevops: false,
      },
      message: 'where does this belong',
      context: { ...(orgGraph ? { orgGraph } : {}) },
    });
    await h.server.waitFor('chat.done', (d) => d.chatId === chatId);
    return results;
  }

  it('answers from org/graph/ of the organization vault; the other CEO verbs still go to the server', async () => {
    const r = await chat('ceo', { vaultId: ORG_VAULT });
    expect(r.route).toMatchObject({
      ok: true,
      result: { text: expect.stringContaining('1. SHOP Web shop: area apps/checkout matches "checkout"') },
    });
    expect(r.snapshot.ok).toBeDefined(); // forwarded: the fake server answers
    expect(r.drafts).toMatchObject({
      ok: true,
      result: { text: expect.stringContaining('suggests no links') },
    });
    expect(r.empty).toMatchObject({ ok: false }); // neither a request nor --drafts
  });

  it('is refused when the graph is not on this workstation, and for anyone but the CEO', async () => {
    const none = await chat('ceo', { vaultId: ORG_VAULT }, false);
    expect(none.route).toMatchObject({
      ok: false,
      error: expect.stringMatching(/organization graph is not available/),
    });
    const noScope = await chat('ceo', undefined);
    expect(noScope.route).toMatchObject({ ok: false });
    await h?.stop();
    h = undefined;
    const builder = await chat('builder', { vaultId: ORG_VAULT });
    expect(builder.route).toMatchObject({ ok: false });
    expect(JSON.stringify(builder.route)).not.toContain('SHOP');
  });
});
