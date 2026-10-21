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

// The guided deploy setup, server side (docs/design/deploy-run-ux-design.md v1b): preview, publish through recipe.write,
// observing what was written (setup, hand edits), the dry run before approval, probes and reachability, the deploy scan.

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

describe('preview', () => {
  it('compiles the setup and says what it found, what each update does, and what needs an answer', async () => {
    const p = await call('POST', `${base()}/delivery/setup/preview`, { setup: setup() });
    expect(p.ok).toBe(true);
    expect(p.hash).toBe(compiled().hash);
    expect(p.files.map((f: any) => f.path)).toEqual([
      'recipe.yaml',
      'scripts/production.sh',
      'scripts/uat.sh',
      'setup.json',
    ]);
    expect(p.lint.filter((l: any) => l.level === 'error')).toEqual([]);
    expect(
      p.changes
        .filter((c: any) => c.group === 'question')
        .map((c: any) => c.text)
        .join(' '),
    ).toContain('has not been checked yet');
    expect(
      p.changes.some(
        (c: any) => c.group === 'each_deploy' && c.text.includes('Rebuild and restart only "app"'),
      ),
    ).toBe(true);
    expect(p.differsFromCurrent).toBe(true);
    expect(p.needsDryRun).toEqual(['uat', 'production']);
  });

  it('a setup that cannot be compiled comes back with plain reasons, not an error', async () => {
    const bad = setup();
    (bad.environments[0] as any).app.service = 'a; rm -rf /';
    const p = await call('POST', `${base()}/delivery/setup/preview`, { setup: bad });
    expect(p.ok).toBe(false);
    expect(p.issues.join(' ')).toContain('service name');
    // the lint knows the project: a production target needs the Owner or a gate
    const noGate = setup();
    (noGate.environments[1] as any).releasedBy = 'auto';
    (noGate.environments[1] as any).gate = 'none';
    const q2 = await call('POST', `${base()}/delivery/setup/preview`, { setup: noGate });
    expect(q2.lint.map((l: any) => l.code)).toContain('production_no_gate');
  });

  it('an unknown target is a lint error', async () => {
    const s = setup();
    (s.environments[0] as any).target = 'nowhere';
    const p = await call('POST', `${base()}/delivery/setup/preview`, { setup: s });
    expect(p.lint.map((l: any) => l.code)).toContain('unknown_target');
  });
});

describe('publish through recipe.write, then observe', () => {
  it('only the previewed hash is written; the workstation gets the files; its answer becomes the observed recipe', async () => {
    const c = compiled();
    const wrong = await req('POST', `${base()}/delivery/setup/publish`, {
      setup: setup(),
      setupHash: 'f'.repeat(64),
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('preview_changed');

    const pub = await call(
      'POST',
      `${base()}/delivery/setup/publish`,
      { setup: setup(), setupHash: c.hash },
      202,
    );
    expect(pub.hash).toBe(c.hash);
    const cmd = await sinceCommands('recipe.write', 1);
    expect(cmd.payload).toMatchObject({
      projectId: d.w.projectId,
      vault: { storage: 'local', folder: 'projects/toy' },
      expectedHash: c.hash,
      keep: [],
    });
    expect(cmd.payload.files.map((f: any) => `${f.mode} ${f.path}`)).toEqual([
      '644 recipe.yaml',
      '755 scripts/production.sh',
      '755 scripts/uat.sh',
      '644 setup.json',
    ]);
    // audit + draft + pending state
    expect(
      await q(`SELECT 1 FROM events WHERE type='DeliverySetupPublished' AND payload->>'setupHash'=$1`, [
        c.hash,
      ]),
    ).toHaveLength(1);
    let st = await call('GET', `${base()}/delivery/setup`);
    expect(st.publish).toMatchObject({ status: 'pending', setupHash: c.hash });
    expect(st.draft.setup).toBeTruthy();

    // the workstation wrote the files and reports what is in delivery/ now
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: {
        ok: true,
        committed: true,
        pushed: true,
        vaultCommit: 'a'.repeat(40),
        inspected: inspected(c),
      },
    });
    await until(
      async () => (await call('GET', `${base()}/delivery/setup`)).publish?.status === 'written',
      5000,
      'written',
    );
    st = await call('GET', `${base()}/delivery/setup`);
    expect(st.current).toMatchObject({
      recipePresent: true,
      recipeStatus: 'observed',
      handEdited: [],
      custom: false,
    });
    expect(st.current.setup.environments.map((e: any) => e.name)).toEqual(['uat', 'production']);
    expect(st.current.dryRunOk).toEqual([]);
    // the observed recipe is the one the Owner sees (and approves): the generated files, nothing else
    const row = (await q('SELECT * FROM delivery_recipes WHERE project_id=$1', [d.w.projectId]))[0];
    expect(row.parsed.environments.map((e: any) => e.name)).toEqual(['uat', 'production']);
    expect(row.setup.generator).toBe(SETUP_GENERATOR);
  });

  it('a refusal by the workstation is shown, and nothing is observed', async () => {
    const c = compiled();
    await call('POST', `${base()}/delivery/setup/publish`, { setup: setup(), setupHash: c.hash }, 202);
    const cmd = await sinceCommands('recipe.write', 1);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: false, error: 'scripts/uat.sh contains a hard-coded credential' },
    });
    await until(
      async () => (await call('GET', `${base()}/delivery/setup`)).publish?.status === 'failed',
      5000,
      'failed',
    );
    const st = await call('GET', `${base()}/delivery/setup`);
    expect(st.publish.error).toContain('hard-coded credential');
    expect(st.current.recipePresent).toBe(false);
  });

  it('is for the project owner; an old runner gets a clear 409; lint errors and blockers stop it', async () => {
    const c = compiled();
    const member = await d.member();
    expect(
      (
        await req(
          'POST',
          `${base()}/delivery/setup/publish`,
          { setup: setup(), setupHash: c.hash },
          member.cookie,
        )
      ).status,
    ).toBe(404);
    await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
      d.w.workstationId,
      ['ceo:1', 'delivery:1'],
    ]);
    const old = await req('POST', `${base()}/delivery/setup/publish`, { setup: setup(), setupHash: c.hash });
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe('runner_outdated');
    expect(old.body.error.message).toContain('needs an update for guided setup');
    const st = await call('GET', `${base()}/delivery/setup`);
    expect(st.workstations[0]).toMatchObject({
      canProbe: false,
      blocked: expect.stringContaining('needs an update'),
    });
    expect(st.writeBlocked).toContain('needs an update');
    expect(commands('recipe.write')).toHaveLength(0);
    // a probe on the old runner is refused the same way
    expect((await req('POST', `${base()}/delivery/probe`, { scope: 'local' })).status).toBe(409);
  });
});

describe('hand-edited scripts and the dry run before approval', () => {
  async function observed(edit: Record<string, string> = {}) {
    const c = compiled();
    await observeRecipe(d.w.t.app.ctx, d.w.projectId, inspected(c, edit), d.w.workstationId);
    return c;
  }

  it('a script that is not what the setup compiles to is "edited by hand": a warning, still approvable', async () => {
    await observed({ 'scripts/uat.sh': 'echo changed' });
    const st = await call('GET', `${base()}/delivery/setup`);
    expect(st.current.handEdited).toEqual(['uat']);
    expect(st.current.lint.find((l: any) => l.code === 'hand_edited')).toMatchObject({
      level: 'warn',
      env: 'uat',
    });
    // an edited script is the one that most needs trying without changing anything
    const hash = (
      await q('SELECT observed_hash FROM delivery_recipes WHERE project_id=$1', [d.w.projectId])
    )[0].observed_hash;
    const early = await d.approve(hash);
    expect(early.status).toBe(422);
    expect(early.body.error.message).toContain('uat');
  });

  it('scripts made by an older compiler are "an improved version is available", not hand edits', async () => {
    const c = compiled();
    const old = { ...inspected(c), setup: { ...c.setup, generator: 'setup-0.9' } } as RecipeInspectResult;
    await observeRecipe(d.w.t.app.ctx, d.w.projectId, old, d.w.workstationId);
    const st = await call('GET', `${base()}/delivery/setup`);
    expect(st.current.handEdited).toEqual([]);
    expect(st.current.lint.find((l: any) => l.code === 'generator_outdated')).toMatchObject({
      level: 'warn',
    });
    expect(st.improvedAvailable).toBe(true);
  });

  it('a guided setup is approved only after a successful dry run of exactly that version', async () => {
    await observed();
    const hash = (
      await q('SELECT observed_hash FROM delivery_recipes WHERE project_id=$1', [d.w.projectId])
    )[0].observed_hash;
    const early = await d.approve(hash);
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('dry_run_required');
    expect(early.body.error.message).toContain('uat');

    // "Try it without changing anything" for both environments
    for (const env of ['uat', 'production']) await call('POST', `${base()}/delivery/setup/dry-run`, { env });
    const execs = commands('deploy.exec');
    await until(async () => commands('deploy.exec').length >= 2, 5000, 'two dry runs');
    expect(execs.length >= 0).toBe(true);
    for (const cmd of commands('deploy.exec')) {
      expect(cmd.payload).toMatchObject({ trial: true, dryRun: true, hash });
      r.send('command.result', {
        commandId: cmd.commandId,
        ok: true,
        result: {
          outcome: 'succeeded',
          exitCode: 0,
          health: null,
          smoke: null,
          logTail: 'dry run finished',
          durationMs: 5,
          summary: 'dry run: the script checked its inputs and changed nothing',
        },
      });
    }
    await until(
      async () => (await call('GET', `${base()}/delivery/setup`)).current.dryRunOk.length === 2,
      5000,
      'dry runs recorded',
    );
    const approved = await d.approve(hash);
    expect(approved.status).toBe(200);
    // approval semantics are unchanged: a later change to the files drifts, the old hash stays what was approved
    expect(
      (await q('SELECT status, approved_hash FROM delivery_recipes WHERE project_id=$1', [d.w.projectId]))[0],
    ).toMatchObject({
      status: 'approved',
      approved_hash: hash,
    });
  });

  it('a recipe without a setup.json is custom: no dry run is demanded in a project that never used the guided setup', async () => {
    await q('DELETE FROM delivery_setup_drafts WHERE project_id=$1', [d.w.projectId]);
    const o = await d.observe();
    const st = await call('GET', `${base()}/delivery/setup`);
    expect(st.current).toMatchObject({ custom: true, setup: null });
    expect((await d.approve(o.hash)).status).toBe(200);
  });

  it('...but once the guided setup was used, deleting setup.json does not switch the dry run check off', async () => {
    await call('PUT', `${base()}/delivery/setup`, { setup: setup() });
    const o = await d.observe();
    const early = await d.approve(o.hash);
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('dry_run_required');
  });
});

describe('probes and the reachability of a server', () => {
  const report = (scope: string, extra: Record<string, unknown> = {}) => ({
    scope,
    at: new Date().toISOString(),
    docker: { installed: true, usable: true, version: '29.1', composeVersion: '2.40.0' },
    containers: [],
    composeFiles: [],
    volumes: [],
    folders: [],
    backups: [],
    proxies: [],
    urls: [],
    listeners: [],
    ...extra,
  });

  it("asks the target's workstation, keeps the newest answer, and feeds the change list", async () => {
    const out = await call(
      'POST',
      `${base()}/delivery/probe`,
      { scope: 'local', hints: { composeFiles: ['~/uat/docker-compose.yml'] } },
      202,
    );
    expect(out.workstationId).toBe(d.w.workstationId);
    const cmd = await sinceCommands('deploy.probe', 1);
    expect(cmd.payload).toMatchObject({
      scope: 'local',
      projectId: d.w.projectId,
      hints: { composeFiles: ['~/uat/docker-compose.yml'] },
    });
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: {
        ok: true,
        report: report('local', {
          composeFiles: [
            {
              path: '/home/u/uat/docker-compose.yml',
              project: 'uat',
              services: [
                { name: 'app', build: '/x', ports: [], volumes: [], envFiles: [], vars: [] },
                { name: 'postgres', image: 'postgres:18', ports: [], volumes: [], envFiles: [], vars: [] },
              ],
              volumes: ['pgdata'],
            },
          ],
        }),
      },
    });
    await until(
      async () => (await call('GET', `${base()}/delivery/setup`)).probes.length === 1,
      5000,
      'probe stored',
    );
    const p = await call('POST', `${base()}/delivery/setup/preview`, { setup: setup() });
    const reuse = p.changes
      .filter((c: any) => c.env === 'uat' && c.group === 'reuse')
      .map((c: any) => c.text)
      .join('\n');
    expect(reuse).toContain('Compose file ~/uat/docker-compose.yml (project uat) with 2 parts');
    expect(reuse).toContain('The app part "app"');
    // production was not checked yet
    expect(
      p.changes.some(
        (c: any) => c.env === 'production' && c.group === 'question' && c.text.includes('not been checked'),
      ),
    ).toBe(true);
    // asking again replaces the answer
    await call('POST', `${base()}/delivery/probe`, { scope: 'local' }, 202);
    const cmd2 = await sinceCommands('deploy.probe', 2);
    r.send('command.result', {
      commandId: cmd2.commandId,
      ok: true,
      result: { ok: false, error: 'docker_missing' },
    });
    await until(
      async () => (await call('GET', `${base()}/delivery/setup`)).probes[0]?.error === 'docker_missing',
      5000,
      'replaced',
    );
    const st = await call('GET', `${base()}/delivery/setup`);
    expect(st.probes).toHaveLength(1);
    expect(st.probes[0].errorText).toContain('Docker is not installed');
  });

  it("the answers about ssh hosts and one server become the target's connection state", async () => {
    const prod = d.targets.prod;
    await call('POST', `${base()}/delivery/probe`, { scope: 'ssh_hosts' }, 202);
    const hosts = await sinceCommands('deploy.probe', 1);
    r.send('command.result', {
      commandId: hosts.commandId,
      ok: true,
      result: {
        ok: true,
        report: report('ssh_hosts', {
          sshHosts: [
            {
              alias: 'prod',
              hostname: '192.0.2.10',
              user: 'root',
              hasIdentity: true,
              state: 'asks_password',
              detail: 'it did not accept the sign-in without a password',
            },
          ],
        }),
      },
    });
    await until(
      async () =>
        (await call('GET', `${base()}/delivery/setup`)).targets.find((t: any) => t.id === prod)?.connection !=
        null,
      5000,
      'connection',
    );
    let t = (await call('GET', `${base()}/delivery/setup`)).targets.find((x: any) => x.id === prod);
    expect(t.connection).toMatchObject({ state: 'asks_password' });
    expect(t).toMatchObject({ workstationOnline: true, host: 'prod', production: true });

    await call(
      'POST',
      `${base()}/delivery/probe`,
      { scope: 'ssh_target', targetId: prod, hints: { dirs: ['/opt/p5'] } },
      202,
    );
    const one = await sinceCommands('deploy.probe', 2);
    expect(one.payload).toMatchObject({ scope: 'ssh_target', host: 'prod', targetId: prod });
    r.send('command.result', {
      commandId: one.commandId,
      ok: true,
      result: { ok: false, error: 'ssh_host_key_changed' },
    });
    await until(
      async () =>
        (await call('GET', `${base()}/delivery/setup`)).targets.find((x: any) => x.id === prod)?.connection
          ?.state === 'host_key_changed',
      5000,
      'changed',
    );
    t = (await call('GET', `${base()}/delivery/setup`)).targets.find((x: any) => x.id === prod);
    expect(t.connection.detail).toContain('identity of prod changed');

    await call('POST', `${base()}/delivery/probe`, { scope: 'ssh_target', targetId: prod }, 202);
    const three = await sinceCommands('deploy.probe', 3);
    r.send('command.result', {
      commandId: three.commandId,
      ok: true,
      result: { ok: true, report: report('ssh_target', { host: 'prod' }) },
    });
    await until(
      async () =>
        (await call('GET', `${base()}/delivery/setup`)).targets.find((x: any) => x.id === prod)?.connection
          ?.state === 'reachable',
      5000,
      'reachable',
    );
  });

  it("a project member without a computer of their own cannot list another person's servers", async () => {
    const member = await d.member();
    const noWs = await req(
      'POST',
      `${base()}/delivery/probe`,
      { scope: 'ssh_hosts', workstationId: d.w.workstationId },
      member.cookie,
    );
    expect([403, 404]).toContain(noWs.status);
  });
});

describe('Scan with DevOps for the deploy setup', () => {
  const scan = (status = 202, body: Record<string, unknown> = {}) =>
    call('POST', `${base()}/scan`, { area: 'deploy', ...body }, status);

  async function shiftFor(requestId: string) {
    const from = r.received.length;
    await d.w.t.app.ctx.services.dispatcher.run();
    const s = (await r.waitFor('shift.start', (f: any) => f.kind === 'devops', 8000, from)) as any;
    r.accepted(s.shiftId);
    r.started(s.shiftId);
    await until(
      async () =>
        (await q(`SELECT status FROM devops_requests WHERE id=$1`, [requestId]))[0]!.status === 'running',
      5000,
      'running',
    );
    return s;
  }
  async function rpc(shiftId: string, method: string, params: Record<string, unknown>) {
    const rpcId = randomUUID();
    const from = r.received.length;
    r.send('rpc.request', { rpcId, shiftId, method, params });
    return (await r.waitFor('rpc.response', (f: any) => f.rpcId === rpcId, 8000, from)) as any;
  }
  beforeEach(async () => {
    await q(`UPDATE devops_requests SET status='done' WHERE status IN ('queued','running','needs_approval')`);
    await q(`UPDATE shifts SET status='ended' WHERE kind='devops' AND status <> 'ended'`);
    await q(`UPDATE setup_proposals SET status='superseded' WHERE status='open'`);
    await q(`DELETE FROM delivery_setup_drafts`);
  });

  it('files a read-only deploy_scan request whose brief lists the targets and probes; the runner must know deploy setup', async () => {
    const { requestId } = await scan();
    expect(
      (await q('SELECT context FROM devops_requests WHERE id=$1', [requestId]))[0].context,
    ).toMatchObject({ requestKind: 'deploy_scan', scanArea: 'deploy' });
    const s = await shiftFor(requestId);
    expect(s.devops.scanKind).toBe('deploy_scan');
    expect(s.devops.scan).toMatchObject({ area: 'deploy' });
    expect(s.devops.scan.deploy.targets.map((t: any) => t.name)).toEqual(['p5-local', 'p5-prod']);
    expect(s.devops.scan.deploy.targets[1]).toMatchObject({
      kind: 'remote_ssh',
      host: 'prod',
      production: true,
    });
    // an older runner is refused with a sentence
    await q(`UPDATE devops_requests SET status='done' WHERE id=$1`, [requestId]);
    await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
      d.w.workstationId,
      ['ceo:1', 'delivery:1', SETUP_SCAN_CAPABILITY],
    ]);
    const old = await req('POST', `${base()}/scan`, { area: 'deploy' });
    expect(old.status).toBe(409);
    expect(old.body.error.message).toContain('too old for deploy scans');
  });

  it("setup.propose checks the deploy proposal against the schema and the project's targets", async () => {
    const { requestId } = await scan();
    const s = await shiftFor(requestId);
    const good = setup();
    const bad = async (mutate: (e: any) => void, text: string) => {
      const p = JSON.parse(JSON.stringify(good));
      mutate(p.environments);
      const res = await rpc(s.shiftId, 'setup.propose', { proposal: { area: 'deploy', deploy: p } });
      expect(res.ok, text).toBe(false);
      expect(res.error, text).toContain(text);
    };
    await bad((e) => (e[0].target = 'nowhere'), 'not a deploy target of this project');
    await bad((e) => (e[1].host = 'other'), 'not a server target with the ssh alias');
    await bad((e) => (e[0].target = 'p5-prod'), 'is a server target, so hosting must be "ssh"');
    await bad((e) => (e[0].app.service = 'a b'), 'invalid proposal');
    await bad((e) => (e[0].mode = 'custom'), 'always guided');
    const run = await rpc(s.shiftId, 'setup.propose', {
      proposal: {
        area: 'deploy',
        deploy: good,
        items: [
          {
            path: '/environments/0/app/service',
            confidence: 'guessed',
            note: 'the only service built from the repo',
          },
        ],
        questions: [
          {
            path: '/environments/0/app/service',
            question: 'Which part is your app?',
            options: ['app', 'web'],
          },
        ],
        notes: 'Found a compose project called uat.',
      },
    });
    expect(run.ok, JSON.stringify(run)).toBe(true);
    const state = await call('GET', `${base()}/delivery/setup`);
    expect(state.proposal).toMatchObject({ area: 'deploy', status: 'open' });
    expect(state.scan).not.toBeNull();

    // a question without an answer blocks it; the answer is stored and applied to the proposal itself
    const early = await req('POST', `${base()}/delivery/setup/use-proposal`, { proposalId: state.proposal.id });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('questions_open');
    const wrong = await req('POST', `/api/setup-proposals/${state.proposal.id}/answers`, {
      answers: [{ path: '/environments/0/app/service', value: 'banana' }],
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.message).toContain('Which part is your app?');
    const answered = await call('POST', `/api/setup-proposals/${state.proposal.id}/answers`, {
      answers: [{ path: '/environments/0/app/service', value: 'web' }],
    });
    expect(answered.proposal.questions[0].answer).toBe('web');
    expect(answered.proposal.deploy.environments[0].app.service).toBe('web');
    // using it makes it the wizard's draft and resolves it; the review (Found / Will change) still comes before saving
    const used = await call('POST', `${base()}/delivery/setup/use-proposal`, {
      proposalId: state.proposal.id,
    });
    expect(used.merge).toEqual({ added: ['uat', 'production'], replaced: [], notCovered: [] });
    expect(used.draft.setup.environments[0].app.service).toBe('web');
    expect(used.proposal).toBeNull();
    expect(used.draft.proposalId).toBe(state.proposal.id);
    expect(used.draft.setup.environments.map((e: any) => e.name)).toEqual(['uat', 'production']);
    expect((await q('SELECT status FROM setup_proposals WHERE id=$1', [state.proposal.id]))[0].status).toBe(
      'accepted',
    );
    expect(await q(`SELECT 1 FROM runner_commands WHERE type='recipe.write'`)).toHaveLength(0);
    // a proposal is used once
    expect(
      (await req('POST', `${base()}/delivery/setup/use-proposal`, { proposalId: state.proposal.id })).status,
    ).toBe(409);
  });

  it('the read-only guard keys on the request kind: a deploy scan shift is read-only even without a brief', async () => {
    const { requestId } = await scan();
    await q(
      `UPDATE devops_requests SET context = jsonb_set(context, '{projectId}', to_jsonb($2::text)) WHERE id=$1`,
      [requestId, randomUUID()],
    );
    await d.w.t.app.ctx.services.dispatcher.run();
    await until(
      async () =>
        (await q('SELECT status FROM devops_requests WHERE id=$1', [requestId]))[0].status === 'failed',
      8000,
      'failed',
    );
  });
});

// last: a rebuild also drops the world's directly inserted deploy targets
describe('replay safety', () => {
  it('rebuilding the projections from the events gives the same drafts, probes, connections and observed setup', async () => {
    const one = { environments: [setup().environments[0]] };
    const c = compiled(one);
    await call('PUT', `${base()}/delivery/setup`, { setup: one, customScripts: { x: 'y' } });
    await call('POST', `${base()}/delivery/setup/publish`, { setup: one, setupHash: c.hash }, 202);
    const cmd = await sinceCommands('recipe.write', 1);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: {
        ok: true,
        committed: true,
        pushed: false,
        vaultCommit: null,
        inspected: inspected(c, { 'scripts/uat.sh': 'edited' }),
      },
    });
    await until(
      async () => (await call('GET', `${base()}/delivery/setup`)).publish?.status === 'written',
      5000,
      'written',
    );
    await call('POST', `${base()}/delivery/probe`, { scope: 'local' }, 202);
    const probe = await sinceCommands('deploy.probe', 1);
    r.send('command.result', {
      commandId: probe.commandId,
      ok: true,
      result: { ok: false, error: 'timeout' },
    });
    await until(
      async () =>
        (
          await q("SELECT 1 FROM deploy_probes WHERE project_id=$1 AND scope='local' AND error='timeout'", [
            d.w.projectId,
          ])
        ).length === 1,
      5000,
      'probe',
    );
    const snap = async () => ({
      drafts: await q(
        'SELECT project_id, setup, custom_scripts, proposal_id, last_publish FROM delivery_setup_drafts ORDER BY project_id',
      ),
      probes: await q(
        'SELECT target_id, workstation_id, scope, host, report, error, detail FROM deploy_probes ORDER BY id',
      ),
      recipes: await q(
        'SELECT status, setup, hand_edited, lint, parsed FROM delivery_recipes ORDER BY project_id',
      ),
    });
    const before = await snap();
    expect(before.recipes[0]?.hand_edited).toEqual(['uat']);
    await d.w.t.app.ctx.notifier.flush();
    await rebuildProjections(d.w.t.app.ctx.pool, d.w.t.app.ctx.store);
    expect(await snap()).toEqual(before);
  });
});
