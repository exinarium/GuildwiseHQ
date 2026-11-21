import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { ORIGIN, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { SoftAuthenticator } from './helpers/webauthn.ts';
import { createWorld, ok, pairWorkstation, until, type World } from './helpers/world.ts';

/**
 * Passkey approvals, server side (R22, DESIGN R18-S2): registration is verified (challenge, origin, RP id, user
 * verification) and offered to the runner, never trusted by the server; removal withdraws the offer; the held list comes
 * from the runner and an assertion for a held item is only relayed. Nothing is approved by the server itself: a held item
 * leaves the list only when the runner reports so, and the two routine kinds are the only ones relayed at all.
 */
let w: World;
let r: FakeRunner | undefined;
const RP_ID = new URL(ORIGIN).hostname;
const base = () => `/api/workstations/${w.workstationId}`;
const as = (cookie = w.owner.cookie) => ({ cookie });

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  r?.close();
  await w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  await q(`DELETE FROM runner_commands`);
});

async function options(cookie = w.owner.cookie) {
  return ok<any>(w.t.req('POST', `${base()}/passkeys/options`, as(cookie)));
}

async function register(auth: SoftAuthenticator, name = 'Laptop key') {
  const o = await options();
  const response = auth.register({ challenge: o.options.challenge, origin: ORIGIN, rpId: RP_ID });
  return w.t.req('POST', `${base()}/passkeys`, {
    ...as(),
    body: { name, registrationToken: o.registrationToken, response },
  });
}

describe('registration', () => {
  it('issues WebAuthn create options for the server host: user verification required, attestation none', async () => {
    const o = await options();
    expect(o.options).toMatchObject({
      rp: { id: RP_ID, name: 'Guildwise' },
      attestation: 'none',
      authenticatorSelection: { userVerification: 'required' },
    });
    expect(
      (o.options.pubKeyCredParams as Array<{ alg: number }>).map((p) => p.alg).sort((a, b) => a - b),
    ).toEqual([-257, -8, -7]);
    expect(typeof o.options.challenge).toBe('string');
    expect(o.registrationToken).toContain(o.options.challenge);
  });

  it("gives each workstation its own user handle, so a passkey for one never replaces another workstation's", async () => {
    const second = await pairWorkstation(w.t, w.owner, 'Laptop');
    const a = await options();
    const b = await ok<any>(
      w.t.req('POST', `/api/workstations/${second.workstationId}/passkeys/options`, as()),
    );
    const handle = (id: string) => createHash('sha256').update(`${w.owner.id}|${id}`).digest('base64url');
    expect(a.options.user.id).toBe(handle(w.workstationId));
    expect(b.options.user.id).toBe(handle(second.workstationId));
    expect(a.options.user.id).not.toBe(b.options.user.id);
    // the same workstation keeps the same handle across registrations
    expect((await options()).options.user.id).toBe(a.options.user.id);
  });

  it('verifies the registration, records it, and offers it to the runner as SPKI with the RP id and origin', async () => {
    r = await w.connectRunner();
    const auth = new SoftAuthenticator(-7);
    const res = await register(auth);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Laptop key', credentialId: auth.id, alg: -7 });

    const [ev] = await q(
      `SELECT payload FROM events WHERE type='WorkstationPasskeyAdded' AND payload->>'credentialId'=$1`,
      [auth.id],
    );
    expect(ev?.payload).toMatchObject({
      workstationId: w.workstationId,
      passkeyId: res.body.id,
      publicKey: auth.spki(),
      alg: -7,
      by: w.owner.id,
    });
    const [row] = await q(`SELECT * FROM workstation_passkeys WHERE id=$1`, [res.body.id]);
    expect(row).toMatchObject({
      workstation_id: w.workstationId,
      user_id: w.owner.id,
      public_key: auth.spki(),
    });
    expect(row?.removed_at).toBeNull();

    const cmd = await r.waitFor('command', (f) => f.command === 'passkey.offer');
    expect(cmd.payload).toMatchObject({
      passkeyId: res.body.id,
      credentialId: auth.id,
      publicKey: auth.spki(),
      alg: -7,
      name: 'Laptop key',
      rpId: RP_ID,
      origin: ORIGIN,
    });
    // an offer is all the server can do: the runner trusts it only after `guildwise-runner passkey trust`
    r.send('command.result', { commandId: cmd.commandId, ok: true, result: { pending: true } });
    await until(
      async () =>
        (await q(`SELECT status FROM runner_commands WHERE id=$1`, [cmd.commandId]))[0]?.status === 'done',
      3000,
      'offer answered',
    );

    const list = await ok<any>(w.t.req('GET', `${base()}/passkeys`, as()));
    expect(list).toMatchObject({ rpId: RP_ID, origin: ORIGIN });
    expect(list.passkeys.map((p: any) => p.credentialId)).toContain(auth.id);
    r.close();
    r = undefined;
  });

  it('converts EdDSA and RS256 keys to the SPKI the runner verifies with node:crypto', async () => {
    for (const alg of [-8, -257] as const) {
      const auth = new SoftAuthenticator(alg);
      const res = await register(auth, `key ${alg}`);
      expect(res.status).toBe(201);
      const [row] = await q(`SELECT public_key, alg FROM workstation_passkeys WHERE id=$1`, [res.body.id]);
      expect(row).toMatchObject({ public_key: auth.spki(), alg });
    }
  });

  it('refuses a wrong origin, a wrong RP id, a wrong challenge, a missing UV flag and a create of the wrong type', async () => {
    const cases: Array<Parameters<SoftAuthenticator['register']>[0] extends infer P ? Partial<P> : never> = [
      { origin: 'https://evil.example' },
      { rpId: 'evil.example' },
      { challenge: randomBytes(32).toString('base64url') },
      { userVerified: false },
      { type: 'webauthn.get' },
    ];
    for (const c of cases) {
      const auth = new SoftAuthenticator();
      const o = await options();
      const response = auth.register({ challenge: o.options.challenge, origin: ORIGIN, rpId: RP_ID, ...c });
      const res = await w.t.req('POST', `${base()}/passkeys`, {
        ...as(),
        body: { name: 'bad', registrationToken: o.registrationToken, response },
      });
      expect(res.status, JSON.stringify(c)).toBe(400);
      expect(res.body.error?.code ?? res.body.code).toBe('passkey_invalid');
      expect(await q(`SELECT 1 FROM workstation_passkeys WHERE credential_id=$1`, [auth.id])).toHaveLength(0);
    }
    expect(await q(`SELECT 1 FROM runner_commands WHERE type='passkey.offer'`)).toHaveLength(0);
  });

  it('refuses a forged, expired, or another workstation’s registration token, and a second registration of a credential', async () => {
    const auth = new SoftAuthenticator();
    const o = await options();
    const response = auth.register({ challenge: o.options.challenge, origin: ORIGIN, rpId: RP_ID });
    const post = (registrationToken: string, url = `${base()}/passkeys`) =>
      w.t.req('POST', url, { ...as(), body: { name: 'k', registrationToken, response } });

    expect((await post(`${o.registrationToken.slice(0, -2)}xx`)).status).toBe(400);
    // a token bound to another workstation id
    const other = randomUUID();
    const forged = o.registrationToken.replace(w.workstationId, other);
    expect((await post(forged)).status).toBe(400);

    w.t.clock.advance(6 * 60_000);
    const late = await post(o.registrationToken);
    expect(late.status).toBe(400);
    expect(late.body.error?.code ?? late.body.code).toBe('passkey_expired');

    const fresh = await options();
    const again = auth.register({ challenge: fresh.options.challenge, origin: ORIGIN, rpId: RP_ID });
    const body = { name: 'k', registrationToken: fresh.registrationToken, response: again };
    expect((await w.t.req('POST', `${base()}/passkeys`, { ...as(), body })).status).toBe(201);
    const fresh2 = await options();
    const twice = auth.register({ challenge: fresh2.options.challenge, origin: ORIGIN, rpId: RP_ID });
    const dup = await w.t.req('POST', `${base()}/passkeys`, {
      ...as(),
      body: { name: 'k', registrationToken: fresh2.registrationToken, response: twice },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.code ?? dup.body.code).toBe('passkey_exists');
  });

  it('is for the workstation owner only, and asks for a fresh "Confirm it\'s you" first', async () => {
    const other = await w.t.userSession(uniqueEmail('other'));
    expect((await w.t.req('POST', `${base()}/passkeys/options`, as(other.cookie))).status).toBe(404);
    expect((await w.t.req('GET', `${base()}/passkeys`, as(other.cookie))).status).toBe(404);
    expect((await w.t.req('POST', `${base()}/passkeys/options`, {})).status).toBe(401);

    const stale = await w.t.userSession(uniqueEmail('stale'));
    await q(`UPDATE auth_sessions SET second_factor_at = now() - interval '2 days' WHERE user_id=$1`, [
      stale.id,
    ]);
    await q(`UPDATE workstations SET user_id=$2 WHERE id=$1`, [w.workstationId, stale.id]);
    try {
      const res = await w.t.req('POST', `${base()}/passkeys/options`, as(stale.cookie));
      expect(res.status).toBe(403);
      expect(res.body.error?.code ?? res.body.code).toBe('step_up_required');
    } finally {
      await q(`UPDATE workstations SET user_id=$2 WHERE id=$1`, [w.workstationId, w.owner.id]);
    }
  });
});

describe('removal', () => {
  it('marks the passkey removed, drops an undelivered offer and sends passkey.withdraw', async () => {
    const auth = new SoftAuthenticator();
    const added = await register(auth, 'to remove');
    expect(added.status).toBe(201);
    // the runner is offline: the offer is still pending
    expect(await q(`SELECT status FROM runner_commands WHERE type='passkey.offer'`)).toEqual([
      { status: 'pending' },
    ]);
    const other = await w.t.userSession(uniqueEmail('x'));
    expect((await w.t.req('DELETE', `${base()}/passkeys/${added.body.id}`, as(other.cookie))).status).toBe(
      404,
    );

    await ok(w.t.req('DELETE', `${base()}/passkeys/${added.body.id}`, as()));
    const [row] = await q(`SELECT removed_at FROM workstation_passkeys WHERE id=$1`, [added.body.id]);
    expect(row?.removed_at).not.toBeNull();
    expect(await q(`SELECT 1 FROM runner_commands WHERE type='passkey.offer'`)).toHaveLength(0);
    const [withdraw] = await q(`SELECT payload FROM runner_commands WHERE type='passkey.withdraw'`);
    expect(withdraw?.payload).toEqual({ passkeyId: added.body.id, credentialId: auth.id });
    const list = await ok<any>(w.t.req('GET', `${base()}/passkeys`, as()));
    expect(list.passkeys.map((p: any) => p.id)).not.toContain(added.body.id);
    expect((await w.t.req('DELETE', `${base()}/passkeys/${added.body.id}`, as())).status).toBe(404);
    expect(PROJECTION_TABLES).toContain('workstation_passkeys');
  });
});

describe('approvals: the held list and the relay of an assertion', () => {
  const auth = new SoftAuthenticator();
  const iso = (ms: number) => new Date(w.t.clock.now().getTime() + ms).toISOString();
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const passkeyBlock = (credentialIds = [auth.id], ttl = 300_000) => ({
    challenge: randomBytes(32).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
    expiresAt: iso(ttl),
    credentialIds,
  });
  const item = (id: string, kind: string, passkey?: ReturnType<typeof passkeyBlock>) => ({
    id,
    kind,
    summary: `${kind} held`,
    commandHash: hash(id),
    createdAt: iso(0),
    expiresAt: iso(86_400_000),
    ...(passkey ? { passkey } : {}),
  });

  it('shows what the runner holds; a passkey challenge on any other kind is never offered', async () => {
    r = await w.connectRunner();
    const empty = await ok<any>(w.t.req('GET', `${base()}/approvals`, as()));
    expect(empty).toMatchObject({ online: true, reportedAt: null, items: [] });

    r.send('approvals.held', {
      items: [
        item('recipe-1', 'recipe.write', passkeyBlock()),
        item('grant-1', 'devops.request', passkeyBlock()),
        item('sudo-1', 'sudo'),
      ],
    });
    await r.barrier();
    const view = await ok<any>(w.t.req('GET', `${base()}/approvals`, as()));
    expect(view.reportedAt).not.toBeNull();
    const by = Object.fromEntries(view.items.map((i: any) => [i.id, i]));
    expect(by['recipe-1']).toMatchObject({ passkeyApprovable: true, passkey: { credentialIds: [auth.id] } });
    expect(by['grant-1'].passkeyApprovable).toBe(false);
    expect(by['grant-1'].passkey).toBeUndefined();
    expect(by['sudo-1'].passkeyApprovable).toBe(false);

    const other = await w.t.userSession(uniqueEmail('o'));
    expect((await w.t.req('GET', `${base()}/approvals`, as(other.cookie))).status).toBe(404);
  });

  it('relays an assertion for a recipe write and a commit-only redeploy; the server approves nothing itself', async () => {
    r ??= await w.connectRunner();
    const recipe = passkeyBlock();
    const redeploy = passkeyBlock();
    r.send('approvals.held', {
      items: [item('recipe-2', 'recipe.write', recipe), item('deploy-2', 'deploy.commit_redeploy', redeploy)],
    });
    await r.barrier();
    const eventsBefore = (await q(`SELECT count(*)::int AS n FROM events`))[0]?.n;

    for (const [id, block] of [
      ['recipe-2', recipe],
      ['deploy-2', redeploy],
    ] as const) {
      const assertion = auth.assert({ challenge: block.challenge, origin: ORIGIN, rpId: RP_ID });
      const res = await ok<any>(
        w.t.req('POST', `${base()}/approvals/${id}/passkey`, { ...as(), body: assertion }),
        202,
      );
      expect(res).toMatchObject({ relayed: true });
      const cmd = await r.waitFor(
        'command',
        (f) => f.command === 'approval.passkey' && f.commandId === res.commandId,
      );
      expect(cmd.payload).toEqual({ itemId: id, ...assertion });
    }
    // relayed is not approved: no event, both items still held until the runner itself reports otherwise
    expect((await q(`SELECT count(*)::int AS n FROM events`))[0]?.n).toBe(eventsBefore);
    const view = await ok<any>(w.t.req('GET', `${base()}/approvals`, as()));
    expect(view.items.map((i: any) => i.id).sort()).toEqual(['deploy-2', 'recipe-2']);
    expect(view.relays.map((x: any) => x.status)).toEqual(['sent', 'sent']);

    // the runner refuses one (spent nonce) and accepts the other; a refusal is final, never retried
    const [a, b] = r
      .of('command')
      .filter((f) => f.command === 'approval.passkey')
      .slice(-2);
    r.send('command.result', { commandId: a?.commandId, ok: false, error: 'nonce already used' });
    r.send('command.result', { commandId: b?.commandId, ok: true, result: { approved: true } });
    r.send('approvals.held', { items: [item('recipe-2', 'recipe.write', passkeyBlock())] });
    await r.barrier();
    const after = await ok<any>(w.t.req('GET', `${base()}/approvals`, as()));
    expect(after.items.map((i: any) => i.id)).toEqual(['recipe-2']);
    const status = Object.fromEntries(after.relays.map((x: any) => [x.itemId, x]));
    expect(status['recipe-2']).toMatchObject({ status: 'refused', error: 'nonce already used' });
    expect(status['deploy-2']).toMatchObject({ status: 'accepted', error: null });
    expect((await q(`SELECT status FROM runner_commands WHERE id=$1`, [a?.commandId]))[0]?.status).toBe(
      'failed',
    );
  });

  it('never relays for a DevOps grant, sudo, a changed deploy or installScripts, an untrusted passkey or a stale challenge', async () => {
    r ??= await w.connectRunner();
    const blocks = Object.fromEntries(
      ['devops.request', 'sudo', 'deploy.exec', 'installScripts', 'recipe.write'].map((k) => [
        k,
        passkeyBlock(),
      ]),
    );
    const stale = passkeyBlock([auth.id], 1000);
    r.send('approvals.held', {
      items: [
        ...Object.entries(blocks).map(([k, b]) => item(`i-${k}`, k, b)),
        item('i-stale', 'recipe.write', stale),
      ],
    });
    await r.barrier();
    const post = (id: string, body: unknown) =>
      w.t.req('POST', `${base()}/approvals/${id}/passkey`, { ...as(), body });
    const assertFor = (block: { challenge: string }, a = auth) =>
      a.assert({ challenge: block.challenge, origin: ORIGIN, rpId: RP_ID });

    for (const k of ['devops.request', 'sudo', 'deploy.exec', 'installScripts']) {
      const res = await post(`i-${k}`, assertFor(blocks[k] as { challenge: string }));
      expect(res.status, k).toBe(409);
      expect(res.body.error?.code ?? res.body.code).toBe('passkey_not_allowed');
    }
    // a passkey the runner does not list as trusted
    const untrusted = await post(
      'i-recipe.write',
      assertFor(blocks['recipe.write'] as { challenge: string }, new SoftAuthenticator()),
    );
    expect(untrusted.status).toBe(409);
    expect(untrusted.body.error?.code ?? untrusted.body.code).toBe('passkey_not_trusted');
    // an assertion over another challenge, or of the wrong type
    const wrong = await post('i-recipe.write', assertFor(blocks.sudo as { challenge: string }));
    expect(wrong.status).toBe(400);
    const created = auth.assert({
      challenge: (blocks['recipe.write'] as { challenge: string }).challenge,
      origin: ORIGIN,
      rpId: RP_ID,
      type: 'webauthn.create',
    });
    expect((await post('i-recipe.write', created)).status).toBe(400);
    // an unknown item, and a challenge past its five minutes
    expect((await post('nope', assertFor(stale))).status).toBe(404);
    w.t.clock.advance(2000);
    const expired = await post('i-stale', assertFor(stale));
    expect(expired.status).toBe(409);
    expect(expired.body.error?.code ?? expired.body.code).toBe('passkey_challenge_expired');

    expect(await q(`SELECT 1 FROM runner_commands WHERE type='approval.passkey'`)).toHaveLength(0);
  });

  it('relays nothing to an offline workstation, and the list is empty after the runner left', async () => {
    r?.close();
    r = undefined;
    await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'runner gone');
    const view = await ok<any>(w.t.req('GET', `${base()}/approvals`, as()));
    expect(view).toMatchObject({ online: false, items: [] });
    const res = await w.t.req('POST', `${base()}/approvals/recipe-2/passkey`, {
      ...as(),
      body: auth.assert({ challenge: 'x', origin: ORIGIN, rpId: RP_ID }),
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.code ?? res.body.code).toBe('workstation_offline');
  });
});
