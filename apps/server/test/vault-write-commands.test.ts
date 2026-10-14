import { randomUUID } from 'node:crypto';
import { VaultWriteCommandSchema } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendStandingOrder, type DecisionRecord, writeDecisionFile } from '../src/commands/decisions.ts';
import { chooseVaultWriteTarget } from '../src/commands/vaults.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, connectMemberRunner } from './helpers/members.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const ctx = () => w.t.app.ctx;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  deskItemId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  projectId: w.projectId,
  question: 'Should the login form use email or username?',
  answer: 'Email. It is unique and already verified.',
  answerOptionLabel: 'Email',
  askedBy: 'Ada (builder)',
  cardRef: 'TOY-4',
  ledgerEntryId: randomUUID(),
  answeredAt: new Date('2026-10-03T12:00:00Z'),
  answeredBy: 'Pieter',
  ...over,
});
const writes = (runner: FakeRunner) => runner.of('command').filter((c) => c.command === 'vault.write');

describe('decision files (QuestionAnswered -> vault.write)', () => {
  it('with no vault registered nothing is written', async () => {
    expect(await writeDecisionFile(ctx(), record())).toEqual({ queued: false, reason: 'no_vault' });
    expect(await writeDecisionFile(ctx(), record({ projectId: randomUUID() }))).toEqual({
      queued: false,
      reason: 'project_not_found',
    });
  });

  it('writes projects/<name>/decisions/<date>-<slug>.md into the organization vault through a durable command', async () => {
    const vault = await ok<any>(
      owner('POST', '/api/vaults', { kind: 'org', remoteUrl: 'git@example.test:srv/work.git' }),
      201,
    );
    const res = await writeDecisionFile(ctx(), record());
    expect(res).toMatchObject({
      queued: true,
      path: 'projects/toy/decisions/2026-10-03-should-the-login-form-use-email-or-username-019e3f.md',
      workstationId: w.workstationId,
    });
    const cmd = await r.waitFor('command', (f) => f.command === 'vault.write');
    const payload = VaultWriteCommandSchema.parse(cmd.payload);
    expect(payload).toMatchObject({
      vaultId: vault.id,
      mode: 'create',
      push: true,
      path: 'projects/toy/decisions/2026-10-03-should-the-login-form-use-email-or-username-019e3f.md',
    });
    expect(payload.commitMessage).toBe('decision TOY-4 Should the login form use email or username?');
    expect(payload.content).toContain('# Should the login form use email or username?');
    expect(payload.content).toContain('Status: accepted');
    expect(payload.content).toContain('Asked by Ada (builder) on card TOY-4.');
    expect(payload.content).toContain('Email: Email. It is unique and already verified.');
    // delivered, then completed by the runner
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { committed: true, pushed: true },
    });
    await until(
      async () =>
        (await q('SELECT 1 FROM runner_commands WHERE id=$1 AND status=$2', [cmd.commandId, 'done']))[0],
    );
  });

  it('a failed command is retried on the next connect and goes to failed after ten attempts', async () => {
    const before = writes(r).length;
    await writeDecisionFile(
      ctx(),
      record({ deskItemId: '019e3f6a-7b1c-7a2d-8c3e-0123456789b2', question: 'Retry me' }),
    );
    const cmd = await r.waitFor(
      'command',
      (f) => f.command === 'vault.write' && /retry-me/.test(String(f.payload.path)),
    );
    r.send('command.result', { commandId: cmd.commandId, ok: false, error: 'push rejected' });
    await until(
      async () =>
        (await q('SELECT status, last_error FROM runner_commands WHERE id=$1', [cmd.commandId]))[0]
          ?.status === 'pending',
    );
    expect(
      (await q('SELECT last_error FROM runner_commands WHERE id=$1', [cmd.commandId]))[0]!.last_error,
    ).toBe('push rejected');
    await q(`UPDATE runner_commands SET attempts=10 WHERE id=$1`, [cmd.commandId]);
    r.send('command.result', { commandId: cmd.commandId, ok: false, error: 'still rejected' });
    await until(
      async () =>
        (await q('SELECT status FROM runner_commands WHERE id=$1', [cmd.commandId]))[0]?.status === 'failed',
    );
    expect(writes(r).length).toBeGreaterThan(before);
  });

  it('is queued while the workstation is offline and delivered on the next connect', async () => {
    r.close();
    const res = await writeDecisionFile(
      ctx(),
      record({ deskItemId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c3', question: 'While offline' }),
    );
    expect(res.queued).toBe(true);
    expect(
      (
        await q(
          `SELECT status FROM runner_commands WHERE type='vault.write' AND payload->>'path' LIKE '%while-offline%'`,
        )
      )[0]!.status,
    ).toBe('pending');
    r = await w.connectRunner();
    const cmd = await r.waitFor('command', (f) => f.command === 'vault.write');
    expect(String(cmd.payload.path)).toContain('while-offline');
  });

  it('a project vault takes precedence and goes to a member workstation when the owner has none online', async () => {
    const pv = await ok<any>(
      owner('POST', '/api/vaults', {
        kind: 'project',
        projectId: w.projectId,
        remoteUrl: 'git@example.test:srv/pv.git',
      }),
      201,
    );
    const res = await writeDecisionFile(
      ctx(),
      record({ deskItemId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d4', question: 'Project vault decision' }),
    );
    expect(res.queued).toBe(true);
    const row = (
      await q(
        `SELECT payload FROM runner_commands WHERE type='vault.write' AND payload->>'path' LIKE '%project-vault-decision%'`,
      )
    )[0]!;
    expect(row.payload.vaultId).toBe(pv.id);
    // target selection: connected workstation holding a clone first, any connected one next, offline last
    const m = await addMember(w, 'writer');
    const mr = await connectMemberRunner(w, m);
    const vault = { id: pv.id, org_id: w.owner.id, project_id: w.projectId };
    r.close();
    await until(
      async () =>
        (await q('SELECT connected FROM workstations WHERE id=$1', [w.workstationId]))[0]!.connected ===
        false,
    );
    expect(await chooseVaultWriteTarget(ctx().pool, vault)).toBe(m.workstationId);
    await q(`INSERT INTO workstation_vaults (workstation_id, vault_id, local_path) VALUES ($1,$2,'/v/o')`, [
      w.workstationId,
      pv.id,
    ]);
    r = await w.connectRunner();
    expect(await chooseVaultWriteTarget(ctx().pool, vault)).toBe(w.workstationId);
    mr.close();
  });
});

describe('standing orders (desk -> vault.write append)', () => {
  it('a project order appends to projects/<name>/standing-orders.md of the project vault', async () => {
    const res = await appendStandingOrder(ctx(), {
      orgId: w.owner.id,
      projectId: w.projectId,
      title: 'Never force-push',
      body: 'All pushes are fast-forward only.',
      at: new Date('2026-10-03T08:00:00Z'),
    });
    expect(res).toMatchObject({ queued: true, path: 'projects/toy/standing-orders.md' });
    const cmd = (
      await q(
        `SELECT payload FROM runner_commands WHERE type='vault.write' AND payload->>'path'='projects/toy/standing-orders.md'`,
      )
    )[0]!.payload;
    expect(cmd).toMatchObject({ mode: 'append', push: true });
    expect(cmd.content).toContain('## Never force-push');
    expect(cmd.content).toContain('All pushes are fast-forward only.');
    expect(cmd.content).toContain('_Added 2026-10-03._');
  });

  it("an organization-wide order appends to the work vault's standing-orders.md", async () => {
    const res = await appendStandingOrder(ctx(), {
      orgId: w.owner.id,
      title: 'Be brief',
      body: 'Short answers.',
    });
    expect(res).toMatchObject({ queued: true, path: 'standing-orders.md' });
    const vault = (await q(`SELECT id FROM vaults WHERE kind='org'`))[0]!;
    const row = (
      await q(
        `SELECT payload FROM runner_commands WHERE type='vault.write' AND payload->>'path'='standing-orders.md'`,
      )
    )[0]!;
    expect(row.payload.vaultId).toBe(vault.id);
  });

  it('without a work vault an organization-wide order is not written', async () => {
    const other = await w.t.userSession(`o-${randomUUID().slice(0, 6)}@example.test`);
    expect(await appendStandingOrder(ctx(), { orgId: other.id, title: 'x', body: 'y' })).toEqual({
      queued: false,
      reason: 'no_vault',
    });
  });
});
