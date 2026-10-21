import { randomUUID } from 'node:crypto';
import {
  compileSetup,
  DEPLOY_SETUP_CAPABILITY,
  localAdoptEnv,
  parseRecipe,
  type RecipeInspectResult,
  SETUP_GENERATOR,
  SETUP_SCAN_CAPABILITY,
  sha256Hex,
  sshShipEnv,
} from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { observeRecipe } from '../src/delivery/recipes.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import { type DeliveryWorld, deliveryWorld } from './helpers/delivery.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { ok, until } from './helpers/world.ts';

// The second round of the v1b review (docs/design/deploy-run-ux-design.md section 14): who may probe and see probes, the dry
// run's requester, files the setup does not make, the newest save winning.

const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];

let d: DeliveryWorld;
let r: FakeRunner;
const CAPS = ['ceo:1', 'delivery:1', DEPLOY_SETUP_CAPABILITY, 'runs:1', 'runs:2', SETUP_SCAN_CAPABILITY];

beforeAll(async () => {
  d = await deliveryWorld();
  r = await d.w.connectRunner({ capabilities: CAPS });
  await keepOnline(d.w);
});
afterAll(async () => {
  r.close();
  await d.w.t.close();
  await closeAdminPool();
});

const base = () => `/api/projects/${d.w.projectId}`;
const req = (method: string, url: string, body?: unknown, cookie = d.w.owner.cookie) =>
  d.w.t.req(method, url, {
    cookie,
    headers: { 'x-aom-org': d.orgId },
    ...(body === undefined ? {} : { body }),
  });
const call = (method: string, url: string, body?: unknown, status = 200, cookie = d.w.owner.cookie) =>
  ok<any>(req(method, url, body, cookie), status);

/** The two environments of the world's targets: p5-local on this computer and p5-prod over ssh (alias `prod`). */
const setup = () => ({
  environments: [
    localAdoptEnv({
      name: 'uat',
      label: 'Test copy',
      target: 'p5-local',
      composeFile: '~/uat/docker-compose.yml',
      composeProject: 'uat',
      service: 'app',
      imageName: 'uat-app',
      appUrl: 'http://localhost:5500',
      database: { service: 'postgres', dir: '~/uat/backups' },
    }),
    sshShipEnv(
      {
        name: 'production',
        label: 'Live site',
        target: 'p5-prod',
        host: 'prod',
        composeFile: '/opt/p5/docker-compose.yml',
        service: 'app',
        imageName: 'p5',
        imageVar: 'P5_IMAGE',
        healthUrl: 'https://p5.example.com/ready',
        database: { service: 'postgres', dir: '/opt/p5/backups' },
      },
      'uat',
    ),
  ],
});

const commands = (type: string) => r.of('command').filter((c) => c.command === type);
const sinceCommands = async (type: string, n: number) => {
  await until(async () => commands(type).length >= n, 5000, `${type} #${n}`);
  return commands(type)[n - 1] as { commandId: string; payload: any };
};

/** What the workstation reports after writing these compiled files. */
function inspected(
  c: Extract<ReturnType<typeof compileSetup>, { ok: true }>,
  edit: Record<string, string> = {},
): RecipeInspectResult {
  const files = c.files.map((f) => ({
    path: f.path,
    mode: f.mode,
    sha256: sha256Hex(edit[f.path] ?? f.content),
    secret: null,
  }));
  const rec = parseRecipe(c.files.find((f) => f.path === 'recipe.yaml')?.content as string);
  if (!rec.ok) throw new Error(rec.error);
  return {
    ok: true,
    present: true,
    vaultCommit: null,
    hash: sha256Hex(JSON.stringify(files)),
    files,
    recipe: rec.recipe,
    lint: [],
    setup: c.setup,
  } as RecipeInspectResult;
}

const compiled = (s: unknown = setup()) => {
  const c = compileSetup(s);
  if (!c.ok) throw new Error(c.issues.join('; '));
  return c;
};

beforeEach(async () => {
  await q(`DELETE FROM delivery_recipes WHERE project_id=$1`, [d.w.projectId]);
  await q(`DELETE FROM runner_commands WHERE type IN ('recipe.write','deploy.probe')`);
  await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
    d.w.workstationId,
    CAPS,
  ]);
  r.received.length = 0;
});

// ------------------------------------------------------------------------------------------ v1b review (round 2)

describe('probes: who may ask what, and who sees the answers (M1)', () => {
  async function projectMember(role: 'owner' | 'manager') {
    const m = await d.member();
    await q(
      `INSERT INTO project_members (project_id, user_id, role, status, joined_at) VALUES ($1,$2,$3,'active',now())
       ON CONFLICT (project_id, user_id) DO UPDATE SET role=EXCLUDED.role, status='active'`,
      [d.w.projectId, m.id, role],
    );
    return m;
  }

  it("a member asks the target's own computer about THAT server only: host and addresses are the target's, hints are dropped", async () => {
    const m = await projectMember('manager');
    const before = commands('deploy.probe').length;
    const out = await req(
      'POST',
      `${base()}/delivery/probe`,
      {
        scope: 'ssh_target',
        targetId: d.targets.prod,
        host: 'evil',
        hints: { dirs: ['/home/other'], composeFiles: ['/etc/shadow'], urls: ['http://169.254.169.254/'] },
      },
      m.cookie,
    );
    expect(out.status).toBe(202);
    const cmd = await sinceCommands('deploy.probe', before + 1);
    expect(cmd.payload.host).toBe('prod');
    expect(cmd.payload.hints.dirs).toBeUndefined();
    expect(cmd.payload.hints.composeFiles).toBeUndefined();
    expect(cmd.payload.hints.urls).toEqual(['https://p5.example.com']);
  });

  it("a member cannot have another person's Docker or server list looked at", async () => {
    const m = await projectMember('manager');
    for (const scope of ['local', 'ssh_hosts']) {
      const res = await req(
        'POST',
        `${base()}/delivery/probe`,
        { scope, targetId: d.targets.prod },
        m.cookie,
      );
      expect(res.status, scope).toBe(403);
    }
  });

  it("probe answers are seen by the computer's owner and the project owner, not by other members", async () => {
    const m = await projectMember('manager');
    await q(`DELETE FROM deploy_probes WHERE project_id=$1`, [d.w.projectId]);
    const n = commands('deploy.probe').length;
    await call('POST', `${base()}/delivery/probe`, { scope: 'local' }, 202);
    const cmd = await sinceCommands('deploy.probe', n + 1);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: {
        ok: true,
        report: {
          scope: 'local',
          at: new Date().toISOString(),
          docker: { installed: true, usable: true },
          containers: [],
          composeFiles: [],
          volumes: [],
          folders: [],
          backups: [],
          proxies: [],
          urls: [],
          listeners: [],
        },
      },
    });
    await until(
      async () => (await call('GET', `${base()}/delivery/probes`)).probes.length > 0,
      5000,
      'probe',
    );
    const seen = await ok<any>(req('GET', `${base()}/delivery/probes`, undefined, m.cookie), 200);
    expect(seen.probes).toEqual([]);
  });
});

describe('dry run and publish safety (M2, M3)', () => {
  beforeEach(async () => {
    await q('DELETE FROM deploy_probes WHERE project_id=$1', [d.w.projectId]);
  });

  it('a dry run is for an org Owner or Admin; a script written by hand only runs for the Owner', async () => {
    const m = await d.member();
    await q(
      `INSERT INTO project_members (project_id, user_id, role, status, joined_at) VALUES ($1,$2,'owner','active',now())
       ON CONFLICT (project_id, user_id) DO UPDATE SET role='owner', status='active'`,
      [d.w.projectId, m.id],
    );
    const c = compiled();
    await observeRecipe(d.w.t.app.ctx, d.w.projectId, inspected(c), d.w.workstationId);
    const asMember = await req('POST', `${base()}/delivery/setup/dry-run`, { env: 'uat' }, m.cookie);
    expect(asMember.status).toBe(403);
    const a = await d.admin();
    await q(
      `INSERT INTO project_members (project_id, user_id, role, status, joined_at) VALUES ($1,$2,'owner','active',now())
       ON CONFLICT (project_id, user_id) DO UPDATE SET role='owner', status='active'`,
      [d.w.projectId, a.id],
    );
    // an admin may try a generated script ...
    const okRun = await req('POST', `${base()}/delivery/setup/dry-run`, { env: 'uat' }, a.cookie);
    expect(okRun.status).toBe(200);
    expect(
      (
        await q(`SELECT requested_by FROM deploy_runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1`, [
          d.w.projectId,
        ])
      )[0].requested_by,
    ).toMatchObject({ kind: 'admin' });
    // ... but not one that was edited by hand
    await observeRecipe(
      d.w.t.app.ctx,
      d.w.projectId,
      inspected(c, { 'scripts/uat.sh': 'echo hi' }),
      d.w.workstationId,
    );
    const hand = await req('POST', `${base()}/delivery/setup/dry-run`, { env: 'uat' }, a.cookie);
    expect(hand.status).toBe(403);
    expect(hand.body.error.message).toContain('Owner');
  });

  it('files the setup does not make are kept unless the Owner names them (M3)', async () => {
    const c = compiled();
    const files = [
      ...c.files.map((f) => ({ path: f.path, mode: f.mode, sha256: sha256Hex(f.content), secret: null })),
      { path: 'scripts/smoke.sh', mode: '755', sha256: 'e'.repeat(64), secret: null },
    ];
    const rec = parseRecipe(c.files.find((f) => f.path === 'recipe.yaml')?.content as string);
    if (!rec.ok) throw new Error(rec.error);
    await observeRecipe(
      d.w.t.app.ctx,
      d.w.projectId,
      {
        ok: true,
        present: true,
        vaultCommit: null,
        hash: sha256Hex(JSON.stringify(files)),
        files,
        recipe: rec.recipe,
        lint: [],
        setup: c.setup,
      } as RecipeInspectResult,
      d.w.workstationId,
    );
    const pv = await call('POST', `${base()}/delivery/setup/preview`, { setup: setup() });
    expect(pv.unmodelled).toEqual(['scripts/smoke.sh']);
    expect(pv.keep).toContain('scripts/smoke.sh');
    expect(pv.removing).toEqual([]);
    const gone = await call('POST', `${base()}/delivery/setup/preview`, {
      setup: setup(),
      removeFiles: ['scripts/smoke.sh'],
    });
    expect(gone.keep).not.toContain('scripts/smoke.sh');
    expect(gone.removing).toEqual(['scripts/smoke.sh']);
    // publishing sends the keep list to the workstation
    const before = commands('recipe.write').length;
    await call('POST', `${base()}/delivery/setup/publish`, { setup: setup(), setupHash: pv.hash }, 202);
    const cmd = await sinceCommands('recipe.write', before + 1);
    expect(cmd.payload.keep).toContain('scripts/smoke.sh');
  });

  it('the newest save wins and an old write expires; a secret in a draft script is refused; a site without a health address is a warning', async () => {
    const a = await call('POST', `${base()}/delivery/setup/preview`, { setup: setup() });
    const n = commands('recipe.write').length;
    await call('POST', `${base()}/delivery/setup/publish`, { setup: setup(), setupHash: a.hash }, 202);
    await call('POST', `${base()}/delivery/setup/publish`, { setup: setup(), setupHash: a.hash }, 202);
    const rows = await q(
      `SELECT status, expires_at FROM runner_commands WHERE type='recipe.write' ORDER BY created_at`,
    );
    expect(rows.at(-1).expires_at).not.toBeNull();
    expect(rows.slice(-2)[0].status).toBe('failed');
    expect(n >= 0).toBe(true);
    const leaked = await req('PUT', `${base()}/delivery/setup`, {
      setup: setup(),
      customScripts: { uat: 'export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD\n' },
    });
    expect(leaked.status).toBe(422);
    const noHealth = setup();
    noHealth.environments[0] = {
      ...noHealth.environments[0]!,
      health: { kind: 'none', graceSec: 5 } as never,
      rollback: false,
    };
    const pv = await call('POST', `${base()}/delivery/setup/preview`, { setup: noHealth });
    expect(pv.lint.find((l: any) => l.code === 'no_health_check')).toMatchObject({
      level: 'warn',
      env: 'uat',
    });
  });
});
