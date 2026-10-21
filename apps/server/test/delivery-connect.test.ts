import { randomUUID } from 'node:crypto';
import {
  compileSetup,
  DEPLOY_CONNECT_CAPABILITY,
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

// Guided connect, dedicated keys, revoke, server preparation, reachability and DevOps probe results (design v2), server side.

const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];

let d: DeliveryWorld;
let r: FakeRunner;
const CAPS = [
  'ceo:1',
  'delivery:1',
  DEPLOY_SETUP_CAPABILITY,
  DEPLOY_CONNECT_CAPABILITY,
  'runs:1',
  'runs:2',
  SETUP_SCAN_CAPABILITY,
];

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

const FP = `SHA256:${'A'.repeat(43)}`;
const FP2 = `SHA256:${'B'.repeat(43)}`;
const PUB = (tag: string) =>
  `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${tag.padEnd(40, 'x')} guildwise-deploy:${tag.slice(0, 8)}:Office-PC`;

const lastCommand = async (type: string, before: number) => {
  await until(async () => commands(type).length > before, 5000, `${type} command`);
  return commands(type)[before] as { commandId: string; payload: any };
};
const answer = (commandId: string, result: unknown, ok = true) =>
  r.send('command.result', { commandId, ok, result });
const op = (id: string, status = 200, cookie = d.w.owner.cookie) =>
  call('GET', `${base()}/delivery/ops/${id}`, undefined, status, cookie);
const opDone = async (id: string) => {
  await until(async () => (await op(id)).state !== 'pending', 5000, 'op answered');
  return op(id);
};

const keyRows = () =>
  q('SELECT * FROM deploy_target_keys WHERE project_id=$1 ORDER BY added_at', [d.w.projectId]);

describe('the host key and the key', () => {
  it('scans the fingerprint from the chosen computer (own computers only) and shows it as an answer', async () => {
    const n = commands('deploy.hostkey').length;
    const started = await call(
      'POST',
      `${base()}/delivery/hostkey`,
      { workstationId: d.w.workstationId, address: 'shop.example.com', port: 22 },
      202,
    );
    expect(started.workstationId).toBe(d.w.workstationId);
    const cmd = await lastCommand('deploy.hostkey', n);
    expect(cmd.payload).toMatchObject({ projectId: d.w.projectId, address: 'shop.example.com', port: 22 });
    expect((await op(started.commandId)).state).toBe('pending');
    answer(cmd.commandId, { ok: true, keys: [{ type: 'ssh-ed25519', fingerprint: FP, bits: 256 }] });
    const done = await opDone(started.commandId);
    expect(done).toMatchObject({
      kind: 'hostkey',
      state: 'done',
      ok: true,
      result: { keys: [{ fingerprint: FP }] },
    });
    // not reachable: a sentence, not a code
    const n2 = commands('deploy.hostkey').length;
    const s2 = await call(
      'POST',
      `${base()}/delivery/hostkey`,
      { workstationId: d.w.workstationId, address: '203.0.113.9', port: 22 },
      202,
    );
    answer((await lastCommand('deploy.hostkey', n2)).commandId, {
      ok: false,
      error: 'unreachable',
      detail: 'Connection refused',
    });
    const failed = await opDone(s2.commandId);
    expect(failed).toMatchObject({ state: 'failed', ok: false });
    expect(failed.errorText).toContain('cannot reach that address');
  });

  it("refuses addresses that are not plain, other people's computers, and a computer that needs an update", async () => {
    for (const address of ['-oProxyCommand=x', 'a b', 'root@host', '$(x)'])
      expect(
        (await req('POST', `${base()}/delivery/hostkey`, { workstationId: d.w.workstationId, address }))
          .status,
        address,
      ).toBe(400);
    const m = await d.member();
    const other = await req(
      'POST',
      `${base()}/delivery/hostkey`,
      { workstationId: d.w.workstationId, address: 'a.example.com' },
      m.cookie,
    );
    expect([403, 404]).toContain(other.status);
    await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
      d.w.workstationId,
      ['ceo:1', 'delivery:1', DEPLOY_SETUP_CAPABILITY],
    ]);
    const old = await req('POST', `${base()}/delivery/hostkey`, {
      workstationId: d.w.workstationId,
      address: 'a.example.com',
    });
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe('runner_outdated');
    await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
      d.w.workstationId,
      CAPS,
    ]);
  });

  it('makes the key before the target exists (a reference) and shows the public line', async () => {
    const n = commands('deploy.key').length;
    const ref = randomUUID();
    const s = await call(
      'POST',
      `${base()}/delivery/key`,
      { workstationId: d.w.workstationId, keyRef: ref },
      202,
    );
    const cmd = await lastCommand('deploy.key', n);
    expect(cmd.payload).toMatchObject({ projectId: d.w.projectId, keyRef: ref, label: expect.any(String) });
    answer(cmd.commandId, { ok: true, publicKey: PUB('abcdef12'), fingerprint: FP, existed: false });
    const done = await opDone(s.commandId);
    expect(done.result).toMatchObject({ publicKey: PUB('abcdef12'), fingerprint: FP });
    expect((await req('POST', `${base()}/delivery/key`, { workstationId: d.w.workstationId })).status).toBe(
      400,
    );
  });
});

describe('connect', () => {
  const connect = (body: Record<string, unknown>, status = 202, cookie = d.w.owner.cookie) =>
    call('POST', `${base()}/delivery/connect`, { workstationId: d.w.workstationId, ...body }, status, cookie);
  const ws = async () =>
    (await q('SELECT key_id FROM workstation_keys WHERE workstation_id=$1', [d.w.workstationId]))[0]
      ?.key_id as string | undefined;

  it('a new server: the target is made with an alias, the sealed password goes to the computer only, and is forgotten when it answers', async () => {
    await q(
      `INSERT INTO workstation_keys (workstation_id, key_id, public_key, updated_at) VALUES ($1,'k1','pk',now()) ON CONFLICT (workstation_id) DO UPDATE SET key_id='k1'`,
      [d.w.workstationId],
    );
    const n = commands('deploy.connect').length;
    const started = await connect({
      newTarget: { name: 'Shop live', production: true },
      method: 'password',
      address: 'shop.example.com',
      user: 'root',
      port: 22,
      hostKeyFingerprint: FP,
      keyId: 'k1',
      ciphertext: 'h1.SEALED.SEALED.SEALED',
    });
    expect(started.alias).toBe('aom-shop-live');
    const target = (await q(`SELECT * FROM deploy_targets WHERE id=$1`, [started.targetId]))[0];
    expect(target).toMatchObject({
      name: 'Shop live',
      kind: 'remote_ssh',
      host: 'aom-shop-live',
      production: true,
      workstation_id: d.w.workstationId,
    });
    const cmd = await lastCommand('deploy.connect', n);
    expect(cmd.payload).toMatchObject({
      method: 'password',
      alias: 'aom-shop-live',
      address: 'shop.example.com',
      user: 'root',
      hostKeyFingerprint: FP,
      targetId: started.targetId,
      ciphertext: 'h1.SEALED.SEALED.SEALED',
    });
    expect(
      (await q(`SELECT expires_at FROM runner_commands WHERE id=$1`, [cmd.commandId]))[0].expires_at,
    ).not.toBeNull();
    answer(cmd.commandId, {
      ok: true,
      publicKey: PUB('11111111'),
      fingerprint: FP,
      hostKeyFingerprint: FP,
      installed: 'added',
      backup: '/home/u/.ssh/authorized_keys.guildwise-bak-1',
    });
    const done = await opDone(started.commandId);
    expect(done).toMatchObject({ kind: 'connect', state: 'done', ok: true });
    // the sealed password is gone from the queue, and from every event
    expect((await q(`SELECT payload FROM runner_commands WHERE id=$1`, [cmd.commandId]))[0].payload).toEqual(
      {},
    );
    expect(JSON.stringify(await q(`SELECT payload FROM events WHERE type LIKE 'Deploy%'`))).not.toContain(
      'SEALED',
    );
    // the key (public parts) and the reachability are facts now
    expect((await keyRows())[0]).toMatchObject({
      target_id: started.targetId,
      workstation_id: d.w.workstationId,
      fingerprint: FP,
      state: 'active',
      alias: 'aom-shop-live',
      address: 'shop.example.com',
      ssh_user: 'root',
      method: 'password',
    });
    const conn = (
      await q(`SELECT * FROM deploy_target_connections WHERE target_id=$1`, [started.targetId])
    )[0];
    expect(conn).toMatchObject({ state: 'reachable', method: 'deploy_key', host: 'aom-shop-live' });
    // the target cards and the setup state show the chip and the keys
    const list = await call('GET', `${base()}/deploy-targets`);
    const card = list.targets.find((t: any) => t.id === started.targetId);
    expect(card.reachability).toMatchObject({ state: 'reachable', method: 'deploy_key' });
    expect(card.keys).toMatchObject([
      { fingerprint: FP, state: 'active', workstationName: expect.any(String) },
    ]);
    const st = await call('GET', `${base()}/delivery/setup`);
    expect(st.workstations.find((w: any) => w.id === d.w.workstationId).canConnect).toBe(true);
    expect(st.targets.find((t: any) => t.id === started.targetId).keys).toHaveLength(1);
    void ws;
  });

  it('a wrong password is a sentence; nothing is recorded as connected; the password is still forgotten', async () => {
    const n = commands('deploy.connect').length;
    const started = await connect({
      newTarget: { name: 'Shop test' },
      method: 'password',
      address: 'test.example.com',
      user: 'deploy',
      port: 22,
      hostKeyFingerprint: FP,
      keyId: 'k1',
      ciphertext: 'h1.SECRETSEALED.x.y',
    });
    const cmd = await lastCommand('deploy.connect', n);
    answer(cmd.commandId, { ok: false, error: 'bad_password' });
    const done = await opDone(started.commandId);
    expect(done).toMatchObject({ state: 'failed', ok: false });
    expect(done.errorText).toContain('did not accept that user name and password');
    expect((await q(`SELECT payload FROM runner_commands WHERE id=$1`, [cmd.commandId]))[0].payload).toEqual(
      {},
    );
    expect((await keyRows()).filter((k: any) => k.target_id === started.targetId)).toHaveLength(0);
    expect(
      await q(`SELECT 1 FROM deploy_target_connections WHERE target_id=$1`, [started.targetId]),
    ).toHaveLength(0);
  });

  it('refuses what is missing or wrong: no secret for a password, a stale runner key, a plain member, a target that is not a server', async () => {
    const base0 = {
      newTarget: { name: 'Other' },
      method: 'password',
      address: 'a.example.com',
      user: 'root',
      port: 22,
      hostKeyFingerprint: FP,
    };
    expect(
      (await req('POST', `${base()}/delivery/connect`, { workstationId: d.w.workstationId, ...base0 }))
        .status,
    ).toBe(400);
    const stale = await req('POST', `${base()}/delivery/connect`, {
      workstationId: d.w.workstationId,
      ...base0,
      keyId: 'old',
      ciphertext: 'x',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('sudo_key_changed');
    const m = await d.member();
    expect([403, 404]).toContain(
      (
        await req(
          'POST',
          `${base()}/delivery/connect`,
          { workstationId: d.w.workstationId, ...base0, keyId: 'k1', ciphertext: 'x' },
          m.cookie,
        )
      ).status,
    );
    const local = await req('POST', `${base()}/delivery/connect`, {
      workstationId: d.w.workstationId,
      targetId: d.targets.local,
      method: 'panel',
      address: 'a.example.com',
      user: 'root',
      port: 22,
      hostKeyFingerprint: FP,
    });
    expect(local.status).toBe(422);
    // an existing sign-in is adopted by its alias, with no secret
    const n = commands('deploy.connect').length;
    const adopt = await connect({ targetId: d.targets.prod, method: 'alias', alias: 'prod' });
    const cmd = await lastCommand('deploy.connect', n);
    expect(cmd.payload).toMatchObject({ method: 'alias', alias: 'prod', targetId: d.targets.prod });
    expect(cmd.payload.ciphertext).toBeUndefined();
    answer(cmd.commandId, { ok: true, publicKey: PUB('22222222'), fingerprint: FP2, installed: 'added' });
    await opDone(adopt.commandId);
    expect((await keyRows()).find((k: any) => k.target_id === d.targets.prod)).toMatchObject({
      method: 'alias',
      address: null,
    });
    expect(
      (
        await req('POST', `${base()}/delivery/connect`, {
          workstationId: d.w.workstationId,
          targetId: d.targets.prod,
          method: 'alias',
          alias: 'someone-else',
        })
      ).status,
    ).toBe(400);
  });

  it('a newer sign-in replaces a sealed one that was never picked up', async () => {
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [d.w.workstationId]).catch(
      () => undefined,
    );
    await q(`UPDATE workstations SET connected=true WHERE id=$1`, [d.w.workstationId]);
    await q(`DELETE FROM runner_commands WHERE type='deploy.connect'`);
    const body = {
      targetId: d.targets.prod,
      method: 'password',
      address: 'a.example.com',
      user: 'root',
      port: 22,
      hostKeyFingerprint: FP,
      keyId: 'k1',
    };
    await q(`UPDATE runner_commands SET status='pending' WHERE false`);
    const first = await connect({ ...body, ciphertext: 'h1.FIRST.x.y' });
    await connect({ ...body, ciphertext: 'h1.SECOND.x.y' });
    const rows2 = await q(
      `SELECT status, payload FROM runner_commands WHERE type='deploy.connect' ORDER BY created_at`,
    );
    expect(rows2.length).toBe(2);
    void first;
    expect(JSON.stringify(rows2)).not.toContain('FIRST');
  });
});

describe('revoke', () => {
  it('removes one Guildwise key of another computer through this computer; never its own', async () => {
    const other = randomUUID();
    await q(`DELETE FROM deploy_target_keys WHERE target_id=$1`, [d.targets.prod]);
    await q(
      `INSERT INTO deploy_target_keys (target_id, workstation_id, project_id, org_id, fingerprint, public_key, alias, method, state, added_at)
       VALUES ($1,$2,$3,$4,$5,$6,'prod','password','active',now()), ($1,$7,$3,$4,$8,$9,'prod','password','active',now())`,
      [
        d.targets.prod,
        other,
        d.w.projectId,
        d.orgId,
        FP2,
        PUB('33333333'),
        d.w.workstationId,
        FP,
        PUB('44444444'),
      ],
    );
    // this computer's own key
    const own = await req('POST', `${base()}/delivery/targets/${d.targets.prod}/revoke-key`, {
      workstationId: d.w.workstationId,
      fingerprint: FP,
    });
    expect(own.status).toBe(422);
    const n = commands('deploy.revoke').length;
    const started = await call(
      'POST',
      `${base()}/delivery/targets/${d.targets.prod}/revoke-key`,
      { workstationId: d.w.workstationId, fingerprint: FP2 },
      202,
    );
    const cmd = await lastCommand('deploy.revoke', n);
    expect(cmd.payload).toMatchObject({
      targetId: d.targets.prod,
      alias: 'prod',
      fingerprint: FP2,
      publicKey: PUB('33333333'),
    });
    answer(cmd.commandId, { ok: true, removed: 1 });
    expect(await opDone(started.commandId)).toMatchObject({ kind: 'revoke', state: 'done' });
    const rows3 = await keyRows();
    expect(rows3.find((k: any) => k.fingerprint === FP2)).toMatchObject({ state: 'revoked' });
    expect(rows3.find((k: any) => k.fingerprint === FP)).toMatchObject({ state: 'active' });
    // an unknown fingerprint is not on the list
    expect(
      (
        await req('POST', `${base()}/delivery/targets/${d.targets.prod}/revoke-key`, {
          workstationId: d.w.workstationId,
          fingerprint: `SHA256:${'C'.repeat(43)}`,
        })
      ).status,
    ).toBe(404);
    // a refusal from the computer is a sentence
    const n2 = commands('deploy.revoke').length;
    await q(`UPDATE deploy_target_keys SET state='active' WHERE fingerprint=$1`, [FP2]);
    const s2 = await call(
      'POST',
      `${base()}/delivery/targets/${d.targets.prod}/revoke-key`,
      { workstationId: d.w.workstationId, fingerprint: FP2 },
      202,
    );
    answer((await lastCommand('deploy.revoke', n2)).commandId, { ok: false, error: 'unreachable' });
    expect((await opDone(s2.commandId)).errorText).toContain('cannot sign in to the server right now');
  });
});

describe('prepare', () => {
  it('needs the confirmation; the closed list goes to the computer; the steps are the record', async () => {
    const actions = [
      { kind: 'install_docker' },
      { kind: 'create_dir', path: '/opt/shop' },
      { kind: 'caddy_site', domain: 'shop.example.com', upstreamPort: 4600 },
    ];
    const body = {
      workstationId: d.w.workstationId,
      targetId: d.targets.prod,
      hosting: 'ssh',
      actions,
      dryRun: false,
    };
    expect((await req('POST', `${base()}/delivery/prepare`, { ...body, confirmed: false })).status).toBe(422);
    expect(
      (
        await req('POST', `${base()}/delivery/prepare`, {
          ...body,
          confirmed: true,
          actions: [{ kind: 'run', cmd: 'rm -rf /' }],
        })
      ).status,
    ).toBe(400);
    const n = commands('deploy.prepare').length;
    const s = await call('POST', `${base()}/delivery/prepare`, { ...body, confirmed: true }, 202);
    const cmd = await lastCommand('deploy.prepare', n);
    expect(cmd.payload).toMatchObject({
      hosting: 'ssh',
      alias: 'prod',
      targetId: d.targets.prod,
      dryRun: false,
    });
    expect(cmd.payload.actions.map((a: any) => a.kind)).toEqual([
      'install_docker',
      'create_dir',
      'caddy_site',
    ]);
    answer(cmd.commandId, {
      ok: true,
      steps: [
        { kind: 'install_docker', outcome: 'done', detail: 'Docker installed' },
        { kind: 'create_dir', outcome: 'skipped', detail: '/opt/shop already exists' },
        { kind: 'caddy_site', outcome: 'done', detail: 'added shop.example.com' },
      ],
    });
    const done = await opDone(s.commandId);
    expect(done).toMatchObject({
      kind: 'prepare',
      state: 'done',
      result: { steps: [{ outcome: 'done' }, { outcome: 'skipped' }, { outcome: 'done' }] },
    });
    const ev = await q(
      `SELECT payload FROM events WHERE type='DeployTargetPrepared' ORDER BY seq DESC LIMIT 1`,
    );
    expect(ev[0].payload).toMatchObject({
      hosting: 'ssh',
      ok: true,
      dryRun: false,
      steps: [{ kind: 'install_docker', outcome: 'done' }, {}, {}],
    });
    // a stop halfway is shown with the sentence
    const n2 = commands('deploy.prepare').length;
    const s2 = await call('POST', `${base()}/delivery/prepare`, { ...body, confirmed: true }, 202);
    answer((await lastCommand('deploy.prepare', n2)).commandId, {
      ok: false,
      error: 'needs_root',
      detail: 'installing Docker needs root or passwordless sudo',
      steps: [{ kind: 'install_docker', outcome: 'failed', detail: 'needs root' }],
    });
    const failed = await opDone(s2.commandId);
    expect(failed).toMatchObject({ state: 'failed' });
    expect(failed.errorText).toContain('needs root');
  });

  it('a new copy on this computer needs no target; a file from the project carries the repository address for the computer to look up', async () => {
    const repo = (
      await q(
        `SELECT name, remote_url_normalized FROM project_repos WHERE project_id=$1 AND removed_at IS NULL ORDER BY name LIMIT 1`,
        [d.w.projectId],
      )
    )[0];
    expect(repo).toBeDefined();
    const n = commands('deploy.prepare').length;
    await call(
      'POST',
      `${base()}/delivery/prepare`,
      {
        workstationId: d.w.workstationId,
        hosting: 'this_computer',
        confirmed: true,
        dryRun: true,
        actions: [
          { kind: 'create_dir', path: '/home/u/guildwise/shop' },
          {
            kind: 'write_compose',
            path: '/home/u/guildwise/shop/docker-compose.yml',
            repoPath: 'docker-compose.yml',
          },
        ],
      },
      202,
    );
    const cmd = await lastCommand('deploy.prepare', n);
    expect(cmd.payload).toMatchObject({ hosting: 'this_computer', dryRun: true });
    expect(cmd.payload.actions[1]).toMatchObject({ remote: repo.remote_url_normalized, repoName: repo.name });
  });
});

/** The target is connected through the guided flow on its own computer (an active key that is not the person's own alias). */
const guided = async (targetId: string, method = 'password') => {
  await q(`DELETE FROM deploy_target_keys WHERE target_id=$1 AND workstation_id=$2`, [targetId, d.w.workstationId]);
  await q(
    `INSERT INTO deploy_target_keys (target_id, workstation_id, project_id, org_id, fingerprint, public_key, alias, method, state, added_at)
     VALUES ($1,$2,$3,$4,$5,$6,'prod',$7,'active',now())`,
    [targetId, d.w.workstationId, d.w.projectId, d.orgId, `SHA256:guided${randomUUID().slice(0, 8)}`, PUB('55555555'), method],
  );
};

describe('reachability', () => {
  it('a server target nobody has checked is checked by its computer (cheap, one at a time); the answer is the card chip; a failure is plain', async () => {
    const { queueReachabilityCheck, reachabilityTick } = await import('../src/delivery/reachability.ts');
    await guided(d.targets.prod);
    await q(`DELETE FROM deploy_target_connections WHERE target_id=$1`, [d.targets.prod]);
    await q(`DELETE FROM runner_commands WHERE type='deploy.probe'`);
    const n = commands('deploy.probe').length;
    expect(await reachabilityTick(d.w.t.app.ctx)).toBeGreaterThanOrEqual(1);
    const cmd = await lastCommand('deploy.probe', n);
    expect(cmd.payload).toMatchObject({
      scope: 'ssh_check',
      targetId: d.targets.prod,
      host: 'prod',
      projectId: d.w.projectId,
    });
    // not asked twice while one is on its way
    expect(await queueReachabilityCheck(d.w.t.app.ctx, d.targets.prod)).toBe(false);
    answer(cmd.commandId, {
      ok: false,
      error: 'ssh_auth',
      detail: 'it did not accept the sign-in without a password',
    });
    await until(
      async () =>
        (await q(`SELECT 1 FROM deploy_target_connections WHERE target_id=$1`, [d.targets.prod])).length > 0,
      5000,
      'chip',
    );
    const list = await call('GET', `${base()}/deploy-targets`);
    const card = list.targets.find((t: any) => t.id === d.targets.prod);
    expect(card.reachability).toMatchObject({ state: 'asks_password' });
    // nothing was stored as a "look at the server"
    expect(await q(`SELECT 1 FROM deploy_probes WHERE scope='ssh_check'`)).toHaveLength(0);
    // fresh answers are left alone for a day
    expect(await reachabilityTick(d.w.t.app.ctx)).toBe(0);
    // the button is rate limited (one a minute per server): an answer a moment ago, and 429
    await call('POST', `${base()}/delivery/targets/${d.targets.prod}/check`, undefined, 429);
    await q(`UPDATE deploy_target_connections SET at = at - interval '5 minutes' WHERE target_id=$1`, [
      d.targets.prod,
    ]);
    // the button: the cheap check when the computer knows it, else the full look
    const n2 = commands('deploy.probe').length;
    await call('POST', `${base()}/delivery/targets/${d.targets.prod}/check`, undefined, 202);
    expect((await lastCommand('deploy.probe', n2)).payload.scope).toBe('ssh_check');
    // and one is already on its way
    await call('POST', `${base()}/delivery/targets/${d.targets.prod}/check`, undefined, 429);
    await q(`DELETE FROM runner_commands WHERE type='deploy.probe' AND status IN ('pending','sent')`);
    await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
      d.w.workstationId,
      ['ceo:1', 'delivery:1', DEPLOY_SETUP_CAPABILITY],
    ]);
    const n3 = commands('deploy.probe').length;
    await call('POST', `${base()}/delivery/targets/${d.targets.prod}/check`, undefined, 202);
    expect((await lastCommand('deploy.probe', n3)).payload.scope).toBe('ssh_target');
    await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
      d.w.workstationId,
      CAPS,
    ]);
  });
});

describe('what a DevOps scan saw is kept', () => {
  async function scanShift() {
    await q(`UPDATE devops_requests SET status='done' WHERE status IN ('queued','running','needs_approval')`);
    await q(`UPDATE shifts SET status='ended' WHERE kind='devops' AND status <> 'ended'`);
    const { requestId } = await call('POST', `${base()}/scan`, { area: 'deploy' }, 202);
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
  const rpc = async (shiftId: string, method: string, params: Record<string, unknown>) => {
    const rpcId = randomUUID();
    const from = r.received.length;
    r.send('rpc.request', { rpcId, shiftId, method, params });
    return (await r.waitFor('rpc.response', (f: any) => f.rpcId === rpcId, 8000, from)) as any;
  };

  it("deploy.probe.record stores the probe like the wizard's own, for the shift's computer and project", async () => {
    const s = await scanShift();
    await q(`DELETE FROM deploy_probes WHERE project_id=$1`, [d.w.projectId]);
    const report = {
      scope: 'ssh_target',
      at: new Date().toISOString(),
      host: 'prod',
      docker: { installed: true, usable: true, version: '29', composeVersion: '2.40.0' },
      containers: [],
      composeFiles: [],
      volumes: [],
      folders: [],
      backups: [],
      proxies: [],
      urls: [],
      listeners: [],
    };
    const res = await rpc(s.shiftId, 'deploy.probe.record', {
      scope: 'ssh_target',
      host: 'prod',
      result: { ok: true, report },
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const rows4 = await q(
      `SELECT scope, host, target_id, workstation_id FROM deploy_probes WHERE project_id=$1`,
      [d.w.projectId],
    );
    expect(rows4).toMatchObject([
      { scope: 'ssh_target', host: 'prod', target_id: d.targets.prod, workstation_id: d.w.workstationId },
    ]);
    // the target's connection state follows
    expect(
      (
        await q(`SELECT state FROM deploy_target_connections WHERE target_id=$1 AND workstation_id=$2`, [
          d.targets.prod,
          d.w.workstationId,
        ])
      )[0].state,
    ).toBe('reachable');
    // an error is kept as an error; nonsense scopes are ignored; the answer never fails DevOps
    expect(
      (await rpc(s.shiftId, 'deploy.probe.record', { scope: 'ssh_check', result: { ok: true } })).result,
    ).toMatchObject({ recorded: false });
    expect(
      (
        await rpc(s.shiftId, 'deploy.probe.record', {
          scope: 'local',
          result: { ok: false, error: 'docker_missing' },
        })
      ).ok,
    ).toBe(true);
    expect(
      (await q(`SELECT error FROM deploy_probes WHERE scope='local' AND project_id=$1`, [d.w.projectId]))[0]
        .error,
    ).toBe('docker_missing');
  });
});

// ------------------------------------------------------------------------------------------ v2 review

describe('v2 review: the server decides what a preparation does', () => {
  const prep = (body: Record<string, unknown>, status = 202) =>
    call(
      'POST',
      `${base()}/delivery/prepare`,
      {
        workstationId: d.w.workstationId,
        targetId: d.targets.prod,
        hosting: 'ssh',
        confirmed: true,
        ...body,
      },
      status,
    );
  const report = (over: Record<string, unknown> = {}) => ({
    scope: 'ssh_target',
    at: new Date().toISOString(),
    host: 'prod',
    docker: { installed: true, usable: true, version: '26.0.0' },
    containers: [],
    composeFiles: [],
    volumes: [],
    folders: [],
    backups: [],
    proxies: [],
    urls: [],
    listeners: [],
    ...over,
  });
  const storeReport = async (rep: unknown) => {
    await q(`DELETE FROM deploy_probes WHERE project_id=$1 AND target_id=$2`, [
      d.w.projectId,
      d.targets.prod,
    ]);
    await q(
      `INSERT INTO deploy_probes (id, org_id, project_id, target_id, workstation_id, scope, host, report, at)
       VALUES ($1,$2,$3,$4,$5,'ssh_target','prod',$6::jsonb,now())`,
      [randomUUID(), d.orgId, d.w.projectId, d.targets.prod, d.w.workstationId, JSON.stringify(rep)],
    );
  };

  it('computes the actions from the inputs and its own look at the server; the list the page sends is not used', async () => {
    await q(`DELETE FROM deploy_probes WHERE project_id=$1 AND target_id=$2`, [
      d.w.projectId,
      d.targets.prod,
    ]);
    const inputs = {
      hosting: 'ssh',
      appDir: '/opt/shop',
      composeFromRepo: { repoPath: 'docker-compose.yml' },
    };
    // nothing looked at yet: refused in words
    const blocked = await req('POST', `${base()}/delivery/prepare`, {
      workstationId: d.w.workstationId,
      targetId: d.targets.prod,
      hosting: 'ssh',
      confirmed: true,
      inputs,
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('prepare_blocked');
    await storeReport(report());
    const n = commands('deploy.prepare').length;
    await prep({
      inputs,
      // a page (or someone) that sends another list: ignored
      actions: [{ kind: 'create_dir', path: '/etc/evil' }],
    });
    const cmd = await lastCommand('deploy.prepare', n);
    const paths = cmd.payload.actions.map((a: any) => a.path ?? a.kind);
    expect(paths).toEqual(['/opt/shop', '/opt/shop/backups', '/opt/shop/docker-compose.yml']);
    expect(JSON.stringify(cmd.payload)).not.toContain('/etc/evil');
  });

  it('nothing to do is an answer, not a command', async () => {
    await storeReport(
      report({
        folders: [{ path: '/opt/shop', exists: true, entries: ['backups'] }],
        composeFiles: [
          {
            path: '/opt/shop/docker-compose.yml',
            services: [{ name: 'app', ports: [], volumes: [], envFiles: [], vars: [] }],
            volumes: [],
          },
        ],
      }),
    );
    const out = await req('POST', `${base()}/delivery/prepare`, {
      workstationId: d.w.workstationId,
      targetId: d.targets.prod,
      hosting: 'ssh',
      confirmed: true,
      inputs: { hosting: 'ssh', appDir: '/opt/shop', composeFromRepo: { repoPath: 'docker-compose.yml' } },
    });
    expect(out.status).toBe(422);
    expect(out.body.error.code).toBe('nothing_to_do');
  });

  it('an older page’s list is checked: a compose file only under the app folder and with a compose file name', async () => {
    // not a compose file name: the schema refuses
    expect(
      (
        await req('POST', `${base()}/delivery/prepare`, {
          workstationId: d.w.workstationId,
          targetId: d.targets.prod,
          hosting: 'ssh',
          confirmed: true,
          actions: [
            { kind: 'write_compose', path: '/opt/shop/authorized_keys', repoPath: 'docker-compose.yml' },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req('POST', `${base()}/delivery/prepare`, {
          workstationId: d.w.workstationId,
          targetId: d.targets.prod,
          hosting: 'ssh',
          confirmed: true,
          actions: [
            { kind: 'write_compose', path: '/opt/shop/docker-compose.yml', repoPath: 'deploy/run.sh' },
          ],
        })
      ).status,
    ).toBe(400);
    // a compose file name, but in a folder that is not being set up
    const bad = await req('POST', `${base()}/delivery/prepare`, {
      workstationId: d.w.workstationId,
      targetId: d.targets.prod,
      hosting: 'ssh',
      confirmed: true,
      actions: [{ kind: 'write_compose', path: '/etc/docker-compose.yml', repoPath: 'docker-compose.yml' }],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('unsafe_prepare');
    // next to a folder the same list creates: fine
    await prep({
      actions: [
        { kind: 'create_dir', path: '/opt/shop' },
        { kind: 'write_compose', path: '/opt/shop/docker-compose.yml', repoPath: 'docker-compose.yml' },
      ],
    });
  });

  it('this computer: not into a hidden folder', async () => {
    const bad = await req('POST', `${base()}/delivery/prepare`, {
      workstationId: d.w.workstationId,
      hosting: 'this_computer',
      confirmed: true,
      actions: [
        { kind: 'create_dir', path: '~/.ssh/shop' },
        { kind: 'write_compose', path: '~/.ssh/shop/docker-compose.yml', repoPath: 'docker-compose.yml' },
      ],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('unsafe_prepare');
  });
});

const report0 = () => ({
  scope: 'ssh_check',
  at: new Date().toISOString(),
  host: 'prod',
  containers: [],
  composeFiles: [],
  volumes: [],
  folders: [],
  backups: [],
  proxies: [],
  urls: [],
  listeners: [],
});

describe('v2 review: reachability answers, connect clean-up, expired sign-ins', () => {
  it('m6: every failed check is a state (an error the page does not know is "cannot reach")', async () => {
    await guided(d.targets.prod);
    await q(`DELETE FROM deploy_target_connections WHERE target_id=$1`, [d.targets.prod]);
    await q(`DELETE FROM runner_commands WHERE type='deploy.probe'`);
    const n = commands('deploy.probe').length;
    const { queueReachabilityCheck } = await import('../src/delivery/reachability.ts');
    expect(await queueReachabilityCheck(d.w.t.app.ctx, d.targets.prod)).toBe(true);
    const cmd = await lastCommand('deploy.probe', n);
    answer(cmd.commandId, { ok: false, error: 'docker_missing', detail: 'odd' });
    await until(
      async () =>
        (await q(`SELECT 1 FROM deploy_target_connections WHERE target_id=$1`, [d.targets.prod])).length > 0,
      5000,
      'chip',
    );
    expect(
      (await q(`SELECT state FROM deploy_target_connections WHERE target_id=$1`, [d.targets.prod]))[0].state,
    ).toBe('unreachable');
  });

  it('a server the computer can no longer reach is put on the desk (and pushed as a runner alert); answering again closes it', async () => {
    const { queueReachabilityCheck } = await import('../src/delivery/reachability.ts');
    await guided(d.targets.prod);
    await q(`DELETE FROM runner_commands WHERE type='deploy.probe'`);
    const subject = `deploy_unreachable:${d.targets.prod}`;
    await q(`DELETE FROM desk_items WHERE subject_key=$1`, [subject]);
    const n = commands('deploy.probe').length;
    expect(await queueReachabilityCheck(d.w.t.app.ctx, d.targets.prod)).toBe(true);
    answer((await lastCommand('deploy.probe', n)).commandId, {
      ok: false,
      error: 'ssh_unreachable',
      detail: 'connection refused',
    });
    await until(
      async () =>
        (await q(`SELECT 1 FROM desk_items WHERE subject_key=$1 AND status='open'`, [subject])).length === 1,
      5000,
      'desk notice',
    );
    const item = (
      await q(`SELECT subkind, kind, title, body FROM desk_items WHERE subject_key=$1`, [subject])
    )[0];
    expect(item).toMatchObject({ subkind: 'deploy_unreachable', kind: 'alert' });
    expect(item.body).toContain('Reconnect');
    // a second failure does not add a second notice
    await q(`DELETE FROM runner_commands WHERE type='deploy.probe'`);
    const n2 = commands('deploy.probe').length;
    expect(await queueReachabilityCheck(d.w.t.app.ctx, d.targets.prod)).toBe(true);
    answer((await lastCommand('deploy.probe', n2)).commandId, { ok: false, error: 'ssh_unreachable' });
    await new Promise((r) => setTimeout(r, 300));
    expect(await q(`SELECT 1 FROM desk_items WHERE subject_key=$1`, [subject])).toHaveLength(1);
    // it answers again: the notice closes
    await q(`DELETE FROM runner_commands WHERE type='deploy.probe'`);
    const n3 = commands('deploy.probe').length;
    expect(await queueReachabilityCheck(d.w.t.app.ctx, d.targets.prod)).toBe(true);
    answer((await lastCommand('deploy.probe', n3)).commandId, { ok: true, report: report0() });
    await until(
      async () =>
        (await q(`SELECT 1 FROM desk_items WHERE subject_key=$1 AND status='open'`, [subject])).length === 0,
      5000,
      'notice closed',
    );
  });

  it('final review: only a target connected through the guided flow is checked by itself; the button and a deploy still work for the rest', async () => {
    const { queueReachabilityCheck, reachabilityTick } = await import('../src/delivery/reachability.ts');
    const none = async () => {
      await q(`DELETE FROM deploy_target_connections WHERE target_id=$1`, [d.targets.prod]);
      await q(`DELETE FROM runner_commands WHERE type='deploy.probe'`);
    };
    // the person's own ssh alias: no key of ours
    await q(`DELETE FROM deploy_target_keys WHERE target_id=$1`, [d.targets.prod]);
    await none();
    const n = commands('deploy.probe').length;
    expect(await queueReachabilityCheck(d.w.t.app.ctx, d.targets.prod)).toBe(false);
    await reachabilityTick(d.w.t.app.ctx);
    // a dedicated key added to the person's own alias is still their config and their agent
    await guided(d.targets.prod, 'alias');
    expect(await queueReachabilityCheck(d.w.t.app.ctx, d.targets.prod)).toBe(false);
    // a revoked guided key does not count
    await guided(d.targets.prod);
    await q(`UPDATE deploy_target_keys SET state='revoked' WHERE target_id=$1`, [d.targets.prod]);
    expect(await queueReachabilityCheck(d.w.t.app.ctx, d.targets.prod)).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(commands('deploy.probe')).toHaveLength(n);
    // the button is on demand: it asks whatever the connection
    await q(`DELETE FROM deploy_target_connections WHERE target_id=$1`, [d.targets.prod]);
    await call('POST', `${base()}/delivery/targets/${d.targets.prod}/check`, undefined, 202);
    expect((await lastCommand('deploy.probe', n)).payload.targetId).toBe(d.targets.prod);
    // a managed one is checked by itself
    await none();
    await guided(d.targets.prod, 'keyfile');
    expect(await queueReachabilityCheck(d.w.t.app.ctx, d.targets.prod)).toBe(true);
  });

  it('m6: only the project owner presses Check connection', async () => {
    const m = await d.member();
    const out = await req('POST', `${base()}/delivery/targets/${d.targets.prod}/check`, undefined, m.cookie);
    expect([403, 404]).toContain(out.status);
  });

  const asNew = async (method: 'password' | 'panel', name: string) => {
    await q(
      `INSERT INTO workstation_keys (workstation_id, key_id, public_key, updated_at) VALUES ($1,'k1','pk',now()) ON CONFLICT (workstation_id) DO UPDATE SET key_id='k1'`,
      [d.w.workstationId],
    );
    const n = commands('deploy.connect').length;
    const started = await call(
      'POST',
      `${base()}/delivery/connect`,
      {
        workstationId: d.w.workstationId,
        newTarget: { name },
        method,
        address: `${name.toLowerCase().replace(/ /g, '-')}.example.com`,
        user: 'root',
        port: 22,
        hostKeyFingerprint: FP,
        ...(method === 'password'
          ? { keyId: 'k1', ciphertext: 'h1.SEALED.SEALED.SEALED' }
          : { keyRef: randomUUID() }),
      },
      202,
    );
    return { started, cmd: await lastCommand('deploy.connect', n) };
  };
  const exists = async (id: string) =>
    (await q(`SELECT 1 FROM deploy_targets WHERE id=$1 AND removed_at IS NULL`, [id])).length === 1;

  it('m11: a new server that did not connect is not left on the list; the copy-paste flow keeps it to try again', async () => {
    const a = await asNew('password', 'Failing box');
    expect(await exists(a.started.targetId)).toBe(true);
    answer(a.cmd.commandId, { ok: false, error: 'bad_password' });
    await opDone(a.started.commandId);
    expect(await exists(a.started.targetId)).toBe(false);
    const b = await asNew('panel', 'Pasting box');
    answer(b.cmd.commandId, { ok: false, error: 'key_not_accepted' });
    await opDone(b.started.commandId);
    expect(await exists(b.started.targetId)).toBe(true);
    const c = await asNew('password', 'Working box');
    answer(c.cmd.commandId, { ok: true, publicKey: PUB('22222222'), fingerprint: FP, installed: 'added' });
    await opDone(c.started.commandId);
    expect(await exists(c.started.targetId)).toBe(true);
  });

  it('m7: a sealed sign-in nobody picked up before it expired is emptied', async () => {
    const { purgeExpiredConnects } = await import('../src/delivery/reachability.ts');
    const a = await asNew('password', 'Expiring box');
    await q(`UPDATE runner_commands SET expires_at = now() - interval '1 minute' WHERE id=$1`, [
      a.cmd.commandId,
    ]);
    expect(await purgeExpiredConnects(d.w.t.app.ctx)).toBeGreaterThanOrEqual(1);
    const row = (await q(`SELECT payload, status FROM runner_commands WHERE id=$1`, [a.cmd.commandId]))[0];
    expect(row.payload).toEqual({});
    expect(row.status).toBe('failed');
  });
});

describe('replay safety', () => {
  it('rebuilding the projections from the events gives the same keys, operations and chips', async () => {
    const before = {
      keys: await q(
        'SELECT target_id, workstation_id, fingerprint, state, alias FROM deploy_target_keys ORDER BY target_id, fingerprint',
      ),
      ops: await q('SELECT command_id, kind, ok FROM deploy_ops ORDER BY command_id'),
      conns: await q('SELECT target_id, state, method FROM deploy_target_connections ORDER BY target_id'),
    };
    expect(before.keys.length).toBeGreaterThan(0);
    await rebuildProjections(d.w.t.app.ctx.pool, d.w.t.app.ctx.store);
    const after = {
      keys: await q(
        'SELECT target_id, workstation_id, fingerprint, state, alias FROM deploy_target_keys ORDER BY target_id, fingerprint',
      ),
      ops: await q('SELECT command_id, kind, ok FROM deploy_ops ORDER BY command_id'),
      conns: await q('SELECT target_id, state, method FROM deploy_target_connections ORDER BY target_id'),
    };
    expect(after.ops).toEqual(before.ops);
    expect(
      after.conns.filter((c: any) => before.conns.some((b: any) => b.target_id === c.target_id)).length,
    ).toBeGreaterThan(0);
    // keys inserted directly by the revoke test have no events; those that came from events are intact
    expect(after.keys.filter((k: any) => k.alias === 'aom-shop-live')).toEqual(
      before.keys.filter((k: any) => k.alias === 'aom-shop-live'),
    );
  });
});
