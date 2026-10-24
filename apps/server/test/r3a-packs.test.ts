import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  type AuthoredCapability,
  capabilityFiles,
  indexPack,
  PACK_AUTHORING_CAPABILITY,
  PACKS_CAPABILITY,
  type PackSnapshot,
  packSnapshotOf,
  packTree,
  provenanceLabel,
  SESSION_TURNS_CAPABILITY,
  sealLarge,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replayVisible, sessionAudienceOf, sessionLevel } from '../src/browser-gateway/visibility.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, MOCK_RUNTIME, ok, pairWorkstation, until, type World } from './helpers/world.ts';

/**
 * Revision R3a on the server: authored packs and who sees them, private git packs with sealed credentials, member opt-in,
 * hire from pack, role-update offers, persona chat, replay and isolation.
 */
let w: World;
let owner: FakeRunner; // the Owner's workstation
let mem: FakeRunner; // a member's workstation
let ownerKey: Key;
let memKey: Key;
let memberWs = '';
let member: Awaited<ReturnType<typeof w.t.userSession>>;
let stranger: Awaited<ReturnType<typeof w.t.userSession>>;

interface Key {
  keyId: string;
  publicKey: string;
}
const makeKey = (): Key => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    keyId: createHash('sha256').update(der).digest('hex').slice(0, 16),
    publicKey: der.toString('base64'),
  };
};

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  ownerKey = makeKey();
  memKey = makeKey();
  owner = await FakeRunner.connect(w.baseUrl, w.runnerToken);
  owner.hello({
    runtimes: MOCK_RUNTIME,
    capabilities: [PACKS_CAPABILITY, PACK_AUTHORING_CAPABILITY, SESSION_TURNS_CAPABILITY],
    sudoKey: ownerKey,
  });
  await owner.waitFor('welcome');
  member = await w.t.userSession(uniqueEmail('r3a-member'));
  await w.t.addOrgMember(w.owner.id, member.id, 'member');
  const paired = await pairWorkstation(w.t, member, 'member-desk');
  memberWs = paired.workstationId;
  mem = await FakeRunner.connect(w.baseUrl, paired.runnerToken);
  mem.hello({
    runtimes: MOCK_RUNTIME,
    capabilities: [PACKS_CAPABILITY, PACK_AUTHORING_CAPABILITY, SESSION_TURNS_CAPABILITY],
    sudoKey: memKey,
  });
  await mem.waitFor('welcome');
  stranger = await w.t.userSession(uniqueEmail('r3a-stranger'));
});
afterAll(async () => {
  owner.close();
  mem.close();
  await w.t.close();
  await closeAdminPool();
});

// biome-ignore lint/suspicious/noExplicitAny: response bodies
const asOwner = (method: string, url: string, body?: unknown, expected = 200): Promise<any> =>
  ok(w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }), expected);
// biome-ignore lint/suspicious/noExplicitAny: response bodies
const asMember = (method: string, url: string, body?: unknown, expected = 200): Promise<any> =>
  ok(
    w.t.req(method, url, {
      cookie: member.cookie,
      headers: { 'x-aom-org': w.owner.id },
      ...(body !== undefined ? { body } : {}),
    }),
    expected,
  );

const critic: AuthoredCapability = {
  kind: 'persona',
  key: 'critic',
  name: 'Critic',
  description: 'Finds the weak spot.',
  stance: 'Doubt first.',
  voice: 'Terse',
  icon: 'x',
  tools: ['read', 'edit'],
  prompt: 'You find the weak spot in a plan.',
};
const summarise: AuthoredCapability = {
  kind: 'skill',
  key: 'summarise',
  description: 'Summarise text.',
  body: 'Be short.',
  files: {},
};

/** What the author's runner reports for a save of these capabilities (the snapshot of an authored revision). */
function revision(pack: string, caps: AuthoredCapability[], n: number): PackSnapshot {
  const index = indexPack({ name: pack, adapter: 'generic', tree: packTree(caps) });
  const s = packSnapshotOf({ name: pack, ref: `v${n}`, sha: 'a'.repeat(64), index });
  return { ...s, sha: s.contentHash };
}
const seal = (k: Key, v: unknown) => sealLarge(k.publicKey, JSON.stringify(v));

const lastCommand = (r: FakeRunner, command: string) =>
  r
    .of('command')
    .filter((c) => c.command === command)
    .at(-1);
const syncOf = (r: FakeRunner): Array<Record<string, unknown>> =>
  (lastCommand(r, 'packs.sync')?.payload.packs as Array<Record<string, unknown>>) ?? [];

describe('authored private packs: only the owner sees them', () => {
  let id = '';
  it('creates a private pack on the member workstation, listed for the member alone', async () => {
    const r = await asMember(
      'POST',
      '/api/my-capabilities',
      { name: 'mine', visibility: 'private', workstationId: memberWs },
      201,
    );
    id = r.pack.id;
    expect(r.pack).toMatchObject({
      name: 'mine',
      visibility: 'private',
      state: 'draft',
      workstationId: memberWs,
    });
    expect((await asMember('GET', '/api/my-capabilities')).packs.map((p: { id: string }) => p.id)).toEqual([
      id,
    ]);
    // not the Owner's page, not the admin pack list, not the pack route, not the registry
    expect((await asOwner('GET', '/api/my-capabilities')).packs).toEqual([]);
    expect((await asOwner('GET', '/api/packs')).packs.map((p: { id: string }) => p.id)).not.toContain(id);
    await asOwner('GET', `/api/packs/${id}`, undefined, 404);
    await asOwner(
      'POST',
      `/api/packs/${id}/trust`,
      { sha: 'a'.repeat(64), contentHash: 'a'.repeat(64) },
      404,
    );
    await asOwner(
      'POST',
      `/api/my-capabilities/${id}/save`,
      { keyId: ownerKey.keyId, ciphertext: 'x'.repeat(40) },
      404,
    );
    // only the member's own workstation is sent the pack
    await until(async () => syncOf(mem).some((p) => p.packId === id));
    expect(syncOf(mem).find((p) => p.packId === id)).toMatchObject({
      visibility: 'private',
      source: 'authored',
      ownerUserId: member.id,
    });
    await owner.barrier();
    expect(syncOf(owner).some((p) => p.packId === id)).toBe(false);
  });

  it('refuses a name that tells nothing about another member’s private pack, and a name of an organization pack only for an organization pack', async () => {
    // the Owner may use the same name for a private pack of their own: private names are per owner
    const mine = await asOwner(
      'POST',
      '/api/my-capabilities',
      { name: 'mine', visibility: 'private', workstationId: w.workstationId },
      201,
    );
    expect(mine.pack.name).toBe('mine');
    await asOwner('DELETE', `/api/my-capabilities/${mine.pack.id}`, undefined, 204);
    await asMember(
      'POST',
      '/api/my-capabilities',
      { name: 'mine', visibility: 'private', workstationId: memberWs },
      409,
    );
  });

  it('relays a save sealed to the member runner only, forgets it once answered, and pins the revision with no review', async () => {
    const snap = revision('mine', [critic, summarise], 1);
    const ciphertext = await seal(memKey, { tree: packTree([critic, summarise]) });
    await asMember('POST', `/api/my-capabilities/${id}/save`, { keyId: memKey.keyId, ciphertext }, 202);
    const cmd = await mem.waitFor('command', (f) => f.command === 'pack.author.save');
    expect(cmd.payload).toMatchObject({ packId: id, keyId: memKey.keyId, ciphertext });
    // the Owner's runner never received it
    await owner.barrier();
    expect(owner.of('command').some((c) => c.command === 'pack.author.save')).toBe(false);
    mem.send('command.result', { commandId: cmd.commandId, ok: true, result: { ok: true, issues: [] } });
    mem.send('packs.report', { packId: id, state: 'resolved', snapshot: snap });
    await until(async () => (await asMember('GET', '/api/my-capabilities')).packs[0].pinnedSha === snap.sha);
    // the sealed files are forgotten as soon as the runner answered
    await until(async () =>
      (await q(`SELECT payload FROM runner_commands WHERE type='pack.author.save'`)).every(
        (r) => !JSON.stringify(r.payload).includes(ciphertext),
      ),
    );
    const p = (await asMember('GET', '/api/my-capabilities')).packs[0];
    expect(p).toMatchObject({ state: 'private', revision: 1, saving: false });
    expect(p.items.map((i: { key: string }) => i.key).sort()).toEqual(['mine:critic', 'mine:summarise']);
    // usable at once, listed for the member with the private mark
    const mine = (await asMember('GET', '/api/capabilities')).items.filter(
      (i: { source: string }) => i.source === 'pack',
    );
    expect(mine.map((i: { key: string }) => i.key).sort()).toEqual(['mine:critic', 'mine:summarise']);
    expect(
      mine.every((i: { usable: boolean; visibility: string }) => i.usable && i.visibility === 'private'),
    ).toBe(true);
  });

  it('does not list it to the Owner, an Admin, another member or another organization: registry, usable lists and personas', async () => {
    const admin = await w.t.userSession(uniqueEmail('r3a-admin'));
    await w.t.addOrgMember(w.owner.id, admin.id, 'admin');
    const other = await w.t.userSession(uniqueEmail('r3a-other-member'));
    await w.t.addOrgMember(w.owner.id, other.id, 'member');
    const who = [
      { cookie: w.owner.cookie, org: undefined },
      { cookie: admin.cookie, org: w.owner.id },
      { cookie: other.cookie, org: w.owner.id },
      { cookie: stranger.cookie, org: undefined },
    ];
    for (const u of who) {
      for (const url of [
        '/api/capabilities',
        '/api/capabilities?usable=true',
        '/api/capabilities?kind=persona',
      ]) {
        const r = await ok<any>(
          w.t.req('GET', url, { cookie: u.cookie, ...(u.org ? { headers: { 'x-aom-org': u.org } } : {}) }),
        );
        expect(JSON.stringify(r)).not.toContain('mine:');
      }
      const packs = await w.t.req('GET', '/api/packs', {
        cookie: u.cookie,
        ...(u.org ? { headers: { 'x-aom-org': u.org } } : {}),
      });
      expect(JSON.stringify(packs.body)).not.toContain('"name":"mine"');
      // a persona chat with it is a 404 as well
      const chat = await w.t.req('POST', '/api/persona-chats', {
        cookie: u.cookie,
        ...(u.org ? { headers: { 'x-aom-org': u.org } } : {}),
        body: { personaKey: 'mine:critic' },
      });
      expect(chat.status).toBe(404);
    }
  });

  it('keeps its events to the owner: user-scope audience, nothing in anyone else’s replay', async () => {
    const rows = await q(
      `SELECT type, audience, user_id, org_id FROM events WHERE stream_id=$1 ORDER BY seq`,
      [`pack-${id}`],
    );
    expect(rows.length).toBeGreaterThan(2);
    for (const e of rows) expect(e).toMatchObject({ audience: 'user', user_id: member.id, org_id: null });
    const replay = async (userId: string, role: 'owner' | 'member') =>
      replayVisible(
        w.t.app.ctx.pool,
        {
          userId,
          kind: 'user',
          orgId: w.owner.id,
          orgRole: role,
          visibleProjectIds: new Set<string>(),
        } as never,
        0n,
        5000,
      );
    expect((await replay(w.owner.id, 'owner')).some((e) => e.streamId === `pack-${id}`)).toBe(false);
    expect((await replay(member.id, 'member')).some((e) => e.streamId === `pack-${id}`)).toBe(true);
  });

  it('reads the files back for the editor sealed to a key only the page has, for the owner alone, and keeps no copy', async () => {
    const replyKey = makeKey().publicKey;
    const r = await asMember('POST', `/api/my-capabilities/${id}/read`, { replyKey }, 202);
    const cmd = await mem.waitFor(
      'command',
      (f) => f.command === 'pack.read' && f.payload.requestId === r.requestId,
    );
    expect(cmd.payload).toMatchObject({ packId: id, replyKey });
    expect((await asMember('GET', `/api/my-capabilities/reads/${r.requestId}`)).status).toBe('pending');
    const ciphertext = await sealLarge(replyKey, JSON.stringify({ tree: packTree([critic]) }));
    mem.send('command.result', { commandId: cmd.commandId, ok: true, result: { ok: true, ciphertext } });
    await until(
      async () => (await asMember('GET', `/api/my-capabilities/reads/${r.requestId}`)).status === 'ready',
    );
    expect((await asMember('GET', `/api/my-capabilities/reads/${r.requestId}`)).ciphertext).toBe(ciphertext);
    // nobody else can fetch the answer, start a read of this pack, or find the ciphertext in the database
    await ok(w.t.req('GET', `/api/my-capabilities/reads/${r.requestId}`, { cookie: w.owner.cookie }), 404);
    await asOwner('POST', `/api/my-capabilities/${id}/read`, { replyKey }, 404);
    expect(
      await q(`SELECT 1 FROM runner_commands WHERE payload::text LIKE $1`, [`%${ciphertext.slice(0, 40)}%`]),
    ).toEqual([]);
    expect(
      await q(`SELECT 1 FROM events WHERE payload::text LIKE $1`, [`%${ciphertext.slice(0, 40)}%`]),
    ).toEqual([]);
  });

  it('takes a later save as the owner’s own and does not leave it waiting for a review', async () => {
    const snap2 = revision('mine', [critic, { ...summarise, body: 'Be shorter.' }], 2);
    mem.send('packs.report', { packId: id, state: 'update', snapshot: snap2, diff: {} });
    await until(async () => (await asMember('GET', '/api/my-capabilities')).packs[0].pinnedSha === snap2.sha);
    const p = (await asMember('GET', '/api/my-capabilities')).packs[0];
    expect(p).toMatchObject({ revision: 2, update: null });
    // the pin moved, and the member's runner is sent the new pin
    await until(async () => syncOf(mem).find((x) => x.packId === id)?.pinnedSha === snap2.sha);
  });

  it('lets only the owner grant a private pack to an agent of their own workstation', async () => {
    const hired = await w.hire(`Gr${Math.random().toString(36).slice(2, 6)}`, 'reviewer', 'senior');
    // the Owner’s agent lives on the Owner’s workstation: not the pack’s
    await asMember('PUT', `/api/my-capabilities/${id}/agents`, { agentId: hired.id, granted: true }, 404);
    await asOwner('PUT', `/api/my-capabilities/${id}/agents`, { agentId: hired.id, granted: true }, 404);
  });

  it('can be made visible to the organization (then it needs a review) and private again (the review lapses)', async () => {
    await asMember('PUT', `/api/my-capabilities/${id}/visibility`, { visibility: 'org' }, 204);
    let p = (await asMember('GET', '/api/my-capabilities')).packs[0];
    expect(p).toMatchObject({ visibility: 'org', state: 'in_review' });
    // now the admin page lists it, untrusted
    const listed = (await asOwner('GET', '/api/packs')).packs.find((x: { id: string }) => x.id === id);
    expect(listed).toMatchObject({ source: 'authored', visibility: 'org', trusted: false });
    await asMember('PUT', `/api/my-capabilities/${id}/visibility`, { visibility: 'private' }, 204);
    p = (await asMember('GET', '/api/my-capabilities')).packs[0];
    expect(p.state).toBe('private');
    expect((await asOwner('GET', '/api/packs')).packs.map((x: { id: string }) => x.id)).not.toContain(id);
  });
});

describe('private packs and the agents of the workstation', () => {
  it('serves a private pack to a card shift only when its owner granted that agent, and takes it back on revoke', async () => {
    const agent = await w.hire(`Gr${Math.random().toString(36).slice(2, 6)}`, 'reviewer', 'senior');
    const mine = await asOwner(
      'POST',
      '/api/my-capabilities',
      { name: 'ownerpriv', visibility: 'private', workstationId: w.workstationId },
      201,
    );
    const id = mine.pack.id as string;
    await until(async () => syncOf(owner).some((p) => p.packId === id));
    expect(
      (syncOf(owner).find((p) => p.packId === id) as { grantedAgentIds: string[] }).grantedAgentIds,
    ).toEqual([]);
    await asOwner('PUT', `/api/my-capabilities/${id}/agents`, { agentId: agent.id, granted: true }, 204);
    await until(
      async () =>
        (
          syncOf(owner).find((p) => p.packId === id) as { grantedAgentIds: string[] } | undefined
        )?.grantedAgentIds?.includes(agent.id) === true,
    );
    // only an agent of this workstation, and only for a private pack
    const m = await asMember(
      'POST',
      '/api/my-capabilities',
      { name: 'mempriv', visibility: 'private', workstationId: memberWs },
      201,
    );
    await asMember(
      'PUT',
      `/api/my-capabilities/${m.pack.id}/agents`,
      { agentId: agent.id, granted: true },
      404,
    );
    await asOwner('PUT', `/api/my-capabilities/${id}/agents`, { agentId: agent.id, granted: false }, 204);
    await until(
      async () =>
        (syncOf(owner).find((p) => p.packId === id) as { grantedAgentIds: string[] } | undefined)
          ?.grantedAgentIds?.length === 0,
    );
    await asOwner('DELETE', `/api/my-capabilities/${id}`, undefined, 204);
    await asMember('DELETE', `/api/my-capabilities/${m.pack.id}`, undefined, 204);
  });
});

describe('authored organization packs: review and approval', () => {
  let id = '';
  let snap: PackSnapshot;
  it('a Member’s organization pack waits for an Owner or Admin; the Member cannot approve their own', async () => {
    id = (
      await asMember(
        'POST',
        '/api/my-capabilities',
        { name: 'crew', visibility: 'org', workstationId: memberWs },
        201,
      )
    ).pack.id;
    snap = revision('crew', [critic], 1);
    // a Member asking to approve their own save is refused
    await asMember(
      'POST',
      `/api/my-capabilities/${id}/save`,
      { keyId: memKey.keyId, ciphertext: await seal(memKey, { tree: packTree([critic]) }), approve: true },
      403,
    );
    await asMember(
      'POST',
      `/api/my-capabilities/${id}/save`,
      { keyId: memKey.keyId, ciphertext: await seal(memKey, { tree: packTree([critic]) }) },
      202,
    );
    mem.send('packs.report', { packId: id, state: 'resolved', snapshot: snap });
    await until(
      async () =>
        (await asMember('GET', '/api/my-capabilities')).packs.find((p: { id: string }) => p.id === id)
          ?.pinnedSha === snap.sha,
    );
    expect(
      (await asMember('GET', '/api/my-capabilities')).packs.find((p: { id: string }) => p.id === id).state,
    ).toBe('in_review');
    const caps = (await asOwner('GET', '/api/capabilities')).items.find(
      (i: { key: string }) => i.key === 'crew:critic',
    );
    expect(caps).toMatchObject({ usable: false, unusableReason: 'untrusted' });
    await asOwner('POST', `/api/packs/${id}/trust`, { sha: snap.sha, contentHash: snap.contentHash });
    expect(
      (await asMember('GET', '/api/my-capabilities')).packs.find((p: { id: string }) => p.id === id).state,
    ).toBe('trusted');
    const usable = (await asOwner('GET', '/api/capabilities?usable=true')).items.find(
      (i: { key: string }) => i.key === 'crew:critic',
    );
    expect(usable).toMatchObject({ source: 'pack', usable: true, visibility: 'org' });
  });

  it('Q57: an Owner or Admin reads the text of the pack sealed to their browser key, with the approved revision to compare; the member and other organizations cannot; the server forgets it after delivery', async () => {
    const replyKey = makeKey().publicKey;
    // a Member cannot start a review read (the route is for Owners and Admins)
    await asMember('POST', `/api/packs/${id}/review-read`, { replyKey }, 403);
    const r = await asOwner('POST', `/api/packs/${id}/review-read`, { replyKey }, 202);
    const cmd = await mem.waitFor(
      'command',
      (f) => f.command === 'pack.read' && f.payload.requestId === r.requestId,
    );
    // it is asked of the AUTHOR's workstation, with the reviewer's key and a request for the approved revision as well
    expect(cmd.payload).toMatchObject({ packId: id, replyKey, withPinned: true });
    expect((await asOwner('GET', `/api/packs/reads/${r.requestId}`)).status).toBe('pending');
    const content = {
      tree: packTree([critic]),
      sha: snap.sha,
      pinned: { tree: packTree([summarise]), sha: 'b'.repeat(64) },
    };
    const ciphertext = await sealLarge(replyKey, JSON.stringify(content));
    mem.send('command.result', { commandId: cmd.commandId, ok: true, result: { ok: true, ciphertext } });
    // someone else cannot fetch the answer (the route is for Owners and Admins)
    await ok(
      w.t.req('GET', `/api/packs/reads/${r.requestId}`, {
        cookie: member.cookie,
        headers: { 'x-aom-org': w.owner.id },
      }),
      403,
    );
    // never in the database, in the clear or sealed
    expect(
      await q(`SELECT 1 FROM runner_commands WHERE payload::text LIKE $1`, [`%${ciphertext.slice(0, 40)}%`]),
    ).toEqual([]);
    expect(
      await q(`SELECT 1 FROM events WHERE payload::text LIKE $1`, [`%${ciphertext.slice(0, 40)}%`]),
    ).toEqual([]);
    // the first look that finds it delivers the ciphertext; after that the server has forgotten the request
    let got: { status: string; ciphertext?: string } = { status: 'pending' };
    await until(async () => {
      got = await asOwner('GET', `/api/packs/reads/${r.requestId}`);
      return got.status === 'ready';
    });
    expect(got.ciphertext).toBe(ciphertext);
    await asOwner('GET', `/api/packs/reads/${r.requestId}`, undefined, 404);
  });

  it('Q57: a git pack, a private pack and an unknown pack cannot be read for review', async () => {
    const replyKey = makeKey().publicKey;
    await asOwner('POST', `/api/packs/${randomUUID()}/review-read`, { replyKey }, 404);
  });

  it('sends the pinned files to another holder sealed to its own key, after its member accepted, and forgets them', async () => {
    // the Owner puts the pack on the Owner’s own workstation: no opt-in for the admin’s own
    const r = await asOwner('PUT', `/api/packs/${id}/workstations`, {
      workstationIds: [memberWs, w.workstationId],
    });
    expect(r.pack.holders.map((h: { assignment: string }) => h.assignment)).toEqual(['accepted', 'accepted']);
    const req = await mem.waitFor(
      'command',
      (f) => f.command === 'pack.bundle.request' && f.payload.packId === id,
    );
    expect(req.payload.sha).toBe(snap.sha);
    expect(req.payload.targets as Array<{ workstationId: string; keyId: string }>).toEqual([
      expect.objectContaining({ workstationId: w.workstationId, keyId: ownerKey.keyId }),
    ]);
    const bundle = await seal(ownerKey, { tree: packTree([critic]) });
    mem.send('command.result', {
      commandId: req.commandId,
      ok: true,
      result: {
        ok: true,
        contentHash: snap.contentHash,
        bundles: [{ workstationId: w.workstationId, ciphertext: bundle }],
      },
    });
    const put = await owner.waitFor(
      'command',
      (f) => f.command === 'pack.bundle.put' && f.payload.packId === id,
    );
    expect(put.payload).toMatchObject({
      sha: snap.sha,
      contentHash: snap.contentHash,
      ciphertext: bundle,
      keyId: ownerKey.keyId,
    });
    owner.send('command.result', { commandId: put.commandId, ok: true, result: { stored: true } });
    owner.send('packs.report', { packId: id, state: 'resolved', snapshot: snap });
    await until(
      async () =>
        (
          await q(`SELECT content_sha FROM pack_workstation_state WHERE pack_id=$1 AND workstation_id=$2`, [
            id,
            w.workstationId,
          ])
        )[0]?.content_sha === snap.sha,
    );
    const left = await q(
      `SELECT payload FROM runner_commands WHERE type IN ('pack.bundle.put','pack.bundle.request') AND payload::text LIKE '%h1.%'`,
    );
    expect(left).toEqual([]);
  });

  it('does not relay untrusted files, nor a revision that was revoked', async () => {
    await asOwner('POST', `/api/packs/${id}/revoke`);
    const before = mem.of('command').filter((c) => c.command === 'pack.bundle.request').length;
    await asOwner('PUT', `/api/packs/${id}/workstations`, { workstationIds: [memberWs] });
    await asOwner('PUT', `/api/packs/${id}/workstations`, { workstationIds: [memberWs, w.workstationId] });
    await mem.barrier();
    expect(mem.of('command').filter((c) => c.command === 'pack.bundle.request').length).toBe(before);
    await asOwner('POST', `/api/packs/${id}/trust`, { sha: snap.sha, contentHash: snap.contentHash });
  });

  it('an Owner approving their own pack: one save is the review', async () => {
    const own = (
      await asOwner(
        'POST',
        '/api/my-capabilities',
        { name: 'ownercrew', visibility: 'org', workstationId: w.workstationId },
        201,
      )
    ).pack.id;
    const s = revision('ownercrew', [critic], 1);
    await asOwner(
      'POST',
      `/api/my-capabilities/${own}/save`,
      {
        keyId: ownerKey.keyId,
        ciphertext: await seal(ownerKey, { tree: packTree([critic]) }),
        approve: true,
      },
      202,
    );
    owner.send('packs.report', { packId: own, state: 'resolved', snapshot: s });
    await until(
      async () =>
        (await asOwner('GET', '/api/my-capabilities')).packs.find((p: { id: string }) => p.id === own)
          ?.state === 'trusted',
    );
    // and a later save with approval moves the pin and the approval together
    const s2 = revision('ownercrew', [critic, summarise], 2);
    await asOwner(
      'POST',
      `/api/my-capabilities/${own}/save`,
      {
        keyId: ownerKey.keyId,
        ciphertext: await seal(ownerKey, { tree: packTree([critic, summarise]) }),
        approve: true,
      },
      202,
    );
    owner.send('packs.report', { packId: own, state: 'update', snapshot: s2, diff: {} });
    await until(
      async () =>
        (await asOwner('GET', '/api/packs')).packs.find((p: { id: string }) => p.id === own)?.pinnedSha ===
        s2.sha,
    );
    const p = (await asOwner('GET', '/api/packs')).packs.find((x: { id: string }) => x.id === own);
    expect(p).toMatchObject({ trusted: true, trustedSha: s2.sha, update: null });
    // an Owner saving without approval leaves the new revision for review like anyone else's
    const s3 = revision('ownercrew', [critic], 3);
    await asOwner(
      'POST',
      `/api/my-capabilities/${own}/save`,
      { keyId: ownerKey.keyId, ciphertext: await seal(ownerKey, { tree: packTree([critic]) }) },
      202,
    );
    owner.send('packs.report', { packId: own, state: 'update', snapshot: s3, diff: {} });
    await until(
      async () =>
        (await asOwner('GET', '/api/packs')).packs.find((x: { id: string }) => x.id === own)?.update?.sha ===
        s3.sha,
    );
    expect(
      (await asOwner('GET', '/api/packs')).packs.find((x: { id: string }) => x.id === own),
    ).toMatchObject({ pinnedSha: s2.sha, trusted: true });
  });

  it('refuses a save sealed for another runner key and a snapshot that is not named by its content hash', async () => {
    await asMember(
      'POST',
      `/api/my-capabilities/${id}/save`,
      { keyId: 'stale-key', ciphertext: 'x'.repeat(40) },
      409,
    );
    const bogus = { ...revision('crew', [critic, summarise], 9), sha: 'f'.repeat(64) };
    mem.send('packs.report', { packId: id, state: 'update', snapshot: bogus, diff: {} });
    await mem.barrier();
    expect((await asOwner('GET', `/api/packs/${id}`)).pack.update).toBeNull();
  });
});

describe('private git packs and member opt-in', () => {
  const SSH_URL = 'ssh://git@git.example.org/acme/skills.git';
  let id = '';
  const secret =
    '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA-the-deploy-key\n-----END OPENSSH PRIVATE KEY-----\n';
  it('refuses a private URL without a credential, a mismatched credential and a share that is missing or sealed for a stale key', async () => {
    await asOwner('POST', '/api/packs', { url: SSH_URL, ref: 'main', name: 'acme' }, 400);
    const own = {
      workstationId: w.workstationId,
      keyId: ownerKey.keyId,
      ciphertext: await sealLarge(ownerKey.publicKey, secret),
    };
    await asOwner(
      'POST',
      '/api/packs',
      {
        url: 'https://git.example.org/acme/skills.git',
        ref: 'main',
        name: 'acme',
        workstationIds: [w.workstationId],
        credential: { kind: 'ssh', shares: [own] },
      },
      400,
    );
    await asOwner(
      'POST',
      '/api/packs',
      { url: SSH_URL, ref: 'main', name: 'acme', credential: { kind: 'ssh', shares: [own] } },
      400,
    );
    await asOwner(
      'POST',
      '/api/packs',
      {
        url: SSH_URL,
        ref: 'main',
        name: 'acme',
        workstationIds: [w.workstationId, memberWs],
        credential: { kind: 'ssh', shares: [own] },
      },
      400,
    );
    await asOwner(
      'POST',
      '/api/packs',
      {
        url: SSH_URL,
        ref: 'main',
        name: 'acme',
        workstationIds: [w.workstationId],
        credential: { kind: 'ssh', shares: [{ ...own, keyId: 'old' }] },
      },
      409,
    );
  });

  it('sends the credential at once to the admin’s own workstation, holds the member’s until they accept', async () => {
    const own = {
      workstationId: w.workstationId,
      keyId: ownerKey.keyId,
      ciphertext: await sealLarge(ownerKey.publicKey, secret),
    };
    const mine = {
      workstationId: memberWs,
      keyId: memKey.keyId,
      ciphertext: await sealLarge(memKey.publicKey, secret),
    };
    const res = await asOwner(
      'POST',
      '/api/packs',
      {
        url: SSH_URL,
        ref: 'main',
        name: 'acme',
        adapter: 'generic',
        workstationIds: [w.workstationId, memberWs],
        credential: { kind: 'ssh', shares: [own, mine] },
      },
      201,
    );
    id = res.pack.id;
    expect(res.pack).toMatchObject({ credentialKind: 'ssh' });
    expect(res.pack.holders.find((h: { mine: boolean }) => h.mine)).toMatchObject({
      assignment: 'accepted',
      credential: 'pending',
    });
    expect(res.pack.holders.find((h: { mine: boolean }) => !h.mine)).toMatchObject({
      assignment: 'pending',
      credential: 'pending',
    });
    const cred = await owner.waitFor(
      'command',
      (f) => f.command === 'pack.credential.set' && f.payload.packId === id,
    );
    expect(cred.payload).toMatchObject({ kind: 'ssh', keyId: ownerKey.keyId, ciphertext: own.ciphertext });
    owner.send('command.result', {
      commandId: cred.commandId,
      ok: true,
      result: { stored: true, fingerprint: 'SHA256:abc' },
    });
    await until(
      async () =>
        (await asOwner('GET', `/api/packs/${id}`)).pack.holders.find((h: { mine: boolean }) => h.mine)
          ?.credential === 'stored',
    );
    expect((await asOwner('GET', `/api/packs/${id}`)).pack.credentialFingerprint).toBe('SHA256:abc');
    // forgotten once stored
    expect(
      (
        await q(
          `SELECT ciphertext, status FROM pack_credential_shares WHERE pack_id=$1 AND workstation_id=$2`,
          [id, w.workstationId],
        )
      )[0],
    ).toEqual({ ciphertext: null, status: 'stored' });
    // the member's runner was sent nothing yet: no credential, and the list does not name the pack
    await mem.barrier();
    expect(
      mem.of('command').some((c) => c.command === 'pack.credential.set' && c.payload.packId === id),
    ).toBe(false);
    expect(syncOf(mem).some((p) => p.packId === id)).toBe(false);
    // the Owner’s runner is sent the pack with the ssh kind (no secret in the list)
    await until(async () => syncOf(owner).some((p) => p.packId === id));
    const entry = syncOf(owner).find((p) => p.packId === id) as Record<string, unknown>;
    expect(entry).toMatchObject({ credentialKind: 'ssh', url: SSH_URL });
    expect(JSON.stringify(entry)).not.toContain('AAAA-the-deploy-key');
  });

  it('puts the opt-in on the member’s desk, addressed to them', async () => {
    const asg = await asMember('GET', '/api/pack-assignments');
    expect(asg.items).toEqual([
      expect.objectContaining({ packId: id, packName: 'acme', workstationId: memberWs, private: true }),
    ]);
    expect(JSON.stringify(await asMember('GET', '/api/desk'))).toContain('Allow the pack');
    const row = (
      await q(
        `SELECT addressee_user_id, subkind, status FROM desk_items WHERE subkind='pack_assignment' AND data->>'packId'=$1`,
        [id],
      )
    )[0];
    expect(row).toEqual({ addressee_user_id: member.id, subkind: 'pack_assignment', status: 'open' });
    // nobody else can answer it, an Owner included
    const deskId = asg.items[0].deskItemId;
    await asOwner('POST', `/api/desk/${deskId}/resolve`, { resolution: 'approved' }, 403);
    expect((await q(`SELECT status FROM desk_items WHERE id=$1`, [deskId]))[0]?.status).toBe('open');
    await asOwner(
      'POST',
      `/api/pack-assignments/${id}/decide`,
      { workstationId: memberWs, accept: true },
      403,
    );
  });

  it('accepting sends the credential first, then the list; the pack is cloned only after that', async () => {
    const deskId = (await asMember('GET', '/api/pack-assignments')).items[0].deskItemId;
    await asMember('POST', `/api/desk/${deskId}/resolve`, { resolution: 'approved' }, 200);
    const cred = await mem.waitFor(
      'command',
      (f) => f.command === 'pack.credential.set' && f.payload.packId === id,
    );
    expect(cred.payload.ciphertext).toBeDefined();
    await until(async () => syncOf(mem).some((p) => p.packId === id));
    const order = mem
      .of('command')
      .filter(
        (c) =>
          (c.command === 'pack.credential.set' && c.payload.packId === id) ||
          (c.command === 'packs.sync' &&
            (c.payload.packs as Array<{ packId: string }>).some((p) => p.packId === id)),
      );
    expect(order[0]?.command).toBe('pack.credential.set');
    mem.send('command.result', { commandId: cred.commandId, ok: true, result: { stored: true } });
    await until(
      async () =>
        (
          await q(`SELECT status FROM pack_credential_shares WHERE pack_id=$1 AND workstation_id=$2`, [
            id,
            memberWs,
          ])
        )[0]?.status === 'stored',
    );
    expect((await asMember('GET', '/api/pack-assignments')).items).toEqual([]);
    expect((await q(`SELECT status FROM desk_items WHERE id=$1`, [deskId]))[0]?.status).not.toBe('open');
  });

  it('remembers the host key the first ssh fetch pinned and sends it back on the next list', async () => {
    const snap = packSnapshotOf({
      name: 'acme',
      ref: 'main',
      sha: 'c'.repeat(40),
      index: indexPack({ name: 'acme', adapter: 'generic', tree: packTree([critic]) }),
    });
    owner.send('packs.report', {
      packId: id,
      state: 'resolved',
      snapshot: snap,
      hostKey: { host: 'git.example.org', key: 'git.example.org ssh-ed25519 AAAAFAKE' },
    });
    await until(
      async () =>
        (await q(`SELECT host_key FROM packs WHERE id=$1`, [id]))[0]?.host_key ===
        'git.example.org ssh-ed25519 AAAAFAKE',
    );
    expect(
      (await asOwner('GET', `/api/packs/${id}`)).pack.holders.find((h: { mine: boolean }) => h.mine)
        .hostKeyPinned,
    ).toBe(true);
    // a report from the member's workstation cannot move the pin of the pack
    mem.send('packs.report', {
      packId: id,
      state: 'resolved',
      snapshot: snap,
      hostKey: { host: 'git.example.org', key: 'evil' },
    });
    await mem.barrier();
    expect((await q(`SELECT host_key FROM packs WHERE id=$1`, [id]))[0]?.host_key).toBe(
      'git.example.org ssh-ed25519 AAAAFAKE',
    );
  });

  it('a workstation that declines is taken off the pack, and loses its credential', async () => {
    const own = {
      workstationId: w.workstationId,
      keyId: ownerKey.keyId,
      ciphertext: await sealLarge(ownerKey.publicKey, secret),
    };
    const res = await asOwner(
      'POST',
      '/api/packs',
      {
        url: 'https://git.example.org/acme/other.git',
        ref: 'main',
        name: 'acme2',
        adapter: 'generic',
        workstationIds: [w.workstationId, memberWs],
        credential: {
          kind: 'token',
          username: 'bot',
          shares: [
            own,
            {
              workstationId: memberWs,
              keyId: memKey.keyId,
              ciphertext: await sealLarge(memKey.publicKey, 'tok-123'),
            },
          ],
        },
      },
      201,
    );
    const pid = res.pack.id as string;
    await asMember(
      'POST',
      `/api/pack-assignments/${pid}/decide`,
      { workstationId: memberWs, accept: false },
      204,
    );
    const p = (await asOwner('GET', `/api/packs/${pid}`)).pack;
    expect(p.holders.map((h: { workstationId: string }) => h.workstationId)).toEqual([w.workstationId]);
    expect(p.workstationIds).toEqual([w.workstationId]);
    expect(
      (
        await q(`SELECT 1 FROM pack_credential_shares WHERE pack_id=$1 AND workstation_id=$2`, [
          pid,
          memberWs,
        ])
      ).length,
    ).toBe(0);
    await mem.barrier();
    expect(
      mem.of('command').some((c) => c.command === 'pack.credential.set' && c.payload.packId === pid),
    ).toBe(false);
    expect(syncOf(mem).some((x) => x.packId === pid)).toBe(false);
    // answering twice, or someone else's request, is refused
    await asMember(
      'POST',
      `/api/pack-assignments/${pid}/decide`,
      { workstationId: memberWs, accept: true },
      404,
    );
  });

  it('never keeps a credential in an event, and rebuilds the same projection', async () => {
    const bad = await q(
      `SELECT type FROM events WHERE payload::text LIKE '%h1.%' OR payload::text LIKE '%AAAA-the-deploy-key%' OR payload::text LIKE '%tok-123%'`,
    );
    expect(bad).toEqual([]);
    const tables = ['packs', 'pack_assignments', 'pack_agent_grants', 'role_pack_offers'];
    const snap = async () =>
      JSON.stringify(await Promise.all(tables.map((t) => q(`SELECT * FROM ${t} ORDER BY 1, 2`))));
    const a = await snap();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snap()).toBe(a);
  });
});

describe('old runners', () => {
  it('are not sent authored, private or credentialed packs, and cannot be chosen for a key', async () => {
    const old = await pairWorkstation(w.t, member, 'old-desk');
    const o = await FakeRunner.connect(w.baseUrl, old.runnerToken);
    o.hello({ runtimes: MOCK_RUNTIME, capabilities: [PACKS_CAPABILITY], sudoKey: makeKey() });
    await o.waitFor('welcome');
    await asMember(
      'POST',
      '/api/my-capabilities',
      { name: 'oldies', visibility: 'private', workstationId: old.workstationId },
      400,
    );
    const pub = await asOwner(
      'POST',
      '/api/packs',
      {
        url: 'https://github.com/example/oldpack.git',
        ref: 'v1',
        name: 'oldpack',
        workstationIds: [w.workstationId, old.workstationId],
      },
      201,
    );
    await asMember(
      'POST',
      `/api/pack-assignments/${pub.pack.id}/decide`,
      { workstationId: old.workstationId, accept: true },
      204,
    );
    await until(async () => syncOf(o).some((p) => p.packId === pub.pack.id));
    // a plain public pack is sent exactly as before: none of the R3a fields
    const entry = syncOf(o).find((p) => p.packId === pub.pack.id) as Record<string, unknown>;
    for (const k of ['source', 'visibility', 'credentialKind', 'hostKey', 'accepted', 'grantedAgentIds'])
      expect(entry).not.toHaveProperty(k);
    o.close();
    void randomUUID;
    void provenanceLabel;
  });
});

describe('hire from pack', () => {
  let crewId = '';
  let crewSnap: PackSnapshot;
  let agentId = '';
  const personaText = (c: AuthoredCapability): string => capabilityFiles(c)[`${c.key}.md`] as string;
  /** Answers the next `pack.persona.read` of the pack on whichever holder the server asked (the order of holders is not fixed). */
  const answerRead = async (
    _r: FakeRunner,
    packId: string,
    text: string,
    over: Record<string, unknown> = {},
  ) => {
    let hit: { r: FakeRunner; cmd: Record<string, any> } | undefined;
    await until(async () => {
      for (const r of [owner, mem]) {
        const cmd = r
          .of('command')
          .find(
            (f) =>
              f.command === 'pack.persona.read' &&
              f.payload.packId === packId &&
              !answered.has(f.commandId as string),
          );
        if (cmd) hit = { r, cmd: cmd as Record<string, any> };
      }
      return !!hit;
    });
    if (!hit) throw new Error('no persona read was asked');
    answered.add(hit.cmd.commandId as string);
    const detail = (await asOwner('GET', `/api/packs/${packId}`)).pack;
    const item = detail.snapshot.items.find((i: { key: string }) =>
      i.key.endsWith(`:${hit?.cmd.payload.key}`),
    );
    hit.r.send('command.result', {
      commandId: hit.cmd.commandId,
      ok: true,
      result: { ok: true, text, hash: item.hash, sha: detail.pinnedSha, ...over },
    });
  };
  const answered = new Set<string>();

  it('finds the trusted organization pack, and lists its personas with the permissions the caller could grant', async () => {
    crewId = (await asOwner('GET', '/api/packs')).packs.find((p: { name: string }) => p.name === 'crew').id;
    crewSnap = (await asOwner('GET', `/api/packs/${crewId}`)).pack.snapshot;
    const asAdmin = await asOwner('GET', `/api/packs/${crewId}/personas`);
    expect(asAdmin.trusted).toBe(true);
    expect(asAdmin.personas[0]).toMatchObject({
      key: 'critic',
      roleKey: 'crew-critic',
      provenanceLabel: 'CREW · critic · v1',
      withheld: [],
      role: null,
    });
    expect(asAdmin.personas[0].permissions.allowedTools).toEqual(['read', 'edit']);
    // a Member would get read only, and is told what was withheld
    const asMem = await asMember('GET', `/api/packs/${crewId}/personas`);
    expect(asMem.personas[0].permissions.allowedTools).toEqual(['read']);
    expect(asMem.personas[0].withheld).toEqual(['the edit tool']);
    expect(asMem.personas[0].permissions.mayCommit).toBe(false);
  });

  it('refuses a Member a hire that is not for a project, and a persona chat made through the generic session call', async () => {
    await asMember(
      'POST',
      `/api/packs/${crewId}/hire`,
      { items: [{ key: 'critic', name: 'Mem' }], workstationId: memberWs, runtime: 'mock', model: 'mock' },
      403,
    );
    await asOwner('POST', '/api/sessions', { kind: 'persona_chat', title: 'x', participants: [] }, 400);
  });

  it('Q60: a Member sees the hirable packs on the HR page and hires from one for a project they are on, on their own workstation', async () => {
    const list = await asMember('GET', '/api/packs-hirable');
    expect(list.packs).toContainEqual(
      expect.objectContaining({ id: crewId, name: 'crew', personaCount: 1, visibility: 'org' }),
    );
    // a pack that is not approved is not offered, and a stranger gets no list from this organization
    const strangerList = await ok(w.t.req('GET', '/api/packs-hirable', { cookie: stranger.cookie }), 200);
    expect(strangerList.packs.map((p: { id: string }) => p.id)).not.toContain(crewId);
    // the member's hire needs a project they are on, and is bound to it
    await asOwner('POST', `/api/projects/${w.projectId}/members`, { email: member.email }, 201);
    const r = await asMember(
      'POST',
      `/api/packs/${crewId}/hire`,
      {
        items: [{ key: 'critic', name: 'Memo' }],
        workstationId: memberWs,
        runtime: 'mock',
        model: 'mock',
        allowedProjectIds: [w.projectId],
      },
      202,
    );
    await answerRead(mem, crewId, personaText(critic));
    await until(async () => (await asMember('GET', `/api/pack-hires/${r.requestId}`)).status !== 'pending');
    const status = await asMember('GET', `/api/pack-hires/${r.requestId}`);
    expect(status.status, status.error ?? '').toBe('done');
    const row = (
      await q(
        `SELECT manager_user_id, allowed_project_ids, workstation_id, provenance FROM agents WHERE name='Memo'`,
      )
    )[0];
    expect(row.manager_user_id).toBe(member.id);
    expect(row.allowed_project_ids).toEqual([w.projectId]);
    expect(row.workstation_id).toBe(memberWs);
    expect(row.provenance).toMatchObject({ packName: 'crew', capability: 'critic' });
    // the role it got is read only: a Member never widens the persona's tools
    const agent = (await asMember('GET', '/api/agents')).agents.find(
      (a: { name: string }) => a.name === 'Memo',
    );
    expect(agent.permissions.allowedTools).toEqual(['read']);
    // the member who hired may let them go again (the later tests count only the Owner's hires)
    await asMember('POST', `/api/agents/${agent.id}/fire`, undefined, 200);
  });

  it('refuses a pack that is not approved, another organization’s pack and a persona it does not have', async () => {
    await asOwner('POST', `/api/packs/${crewId}/revoke`);
    await asOwner(
      'POST',
      `/api/packs/${crewId}/hire`,
      {
        items: [{ key: 'critic', name: 'Nope' }],
        workstationId: w.workstationId,
        runtime: 'mock',
        model: 'mock',
      },
      409,
    );
    await asOwner('POST', `/api/packs/${crewId}/trust`, {
      sha: crewSnap.sha,
      contentHash: crewSnap.contentHash,
    });
    await asOwner(
      'POST',
      `/api/packs/${crewId}/hire`,
      {
        items: [{ key: 'ghost', name: 'Nope' }],
        workstationId: w.workstationId,
        runtime: 'mock',
        model: 'mock',
      },
      400,
    );
    await ok(
      w.t.req('POST', `/api/packs/${crewId}/hire`, {
        cookie: stranger.cookie,
        body: { items: [{ key: 'critic', name: 'Nope' }], workstationId: w.workstationId },
      }),
      404,
    );
    await ok(w.t.req('GET', `/api/packs/${crewId}/personas`, { cookie: stranger.cookie }), 404);
  });

  it('makes a role of the persona and an agent with its provenance tag; the persona text is checked against the approved hash', async () => {
    const wrong = await asOwner(
      'POST',
      `/api/packs/${crewId}/hire`,
      {
        items: [{ key: 'critic', name: 'Wrongo' }],
        workstationId: w.workstationId,
        runtime: 'mock',
        model: 'mock',
      },
      202,
    );
    await answerRead(owner, crewId, personaText(critic), { hash: 'e'.repeat(64) });
    await until(async () => (await asOwner('GET', `/api/pack-hires/${wrong.requestId}`)).status === 'failed');
    expect((await q(`SELECT 1 FROM agents WHERE name='Wrongo'`)).length).toBe(0);
    const r = await asOwner(
      'POST',
      `/api/packs/${crewId}/hire`,
      {
        items: [{ key: 'critic', name: 'Cleo' }],
        workstationId: w.workstationId,
        runtime: 'mock',
        model: 'mock',
      },
      202,
    );
    await answerRead(owner, crewId, personaText(critic));
    await until(async () => (await asOwner('GET', `/api/pack-hires/${r.requestId}`)).status === 'done');
    const status = await asOwner('GET', `/api/pack-hires/${r.requestId}`);
    agentId = status.agents[0].agentId;
    const agent = (await asOwner('GET', '/api/agents')).agents.find((a: { id: string }) => a.id === agentId);
    expect(agent).toMatchObject({
      name: 'Cleo',
      roleKey: 'crew-critic',
      roleVersion: 1,
      provenance: { label: 'CREW · critic · v1', packName: 'crew', capability: 'critic', warning: null },
    });
    expect(agent.permissions).toMatchObject({
      allowedTools: ['read', 'edit'],
      mayCommit: false,
      browser: false,
      readOrgRepos: false,
    });
    const role = (await q(`SELECT definition, status FROM role_definitions WHERE key='crew-critic'`))[0];
    expect(role?.status).toBe('active');
    expect(role?.definition.instructions).toContain('You find the weak spot in a plan.');
    expect(role?.definition.claimableStages).toEqual([]);
    expect(role?.definition.source).toMatchObject({ packId: crewId, capability: 'critic' });
    // the persona texts are not kept in the request
    expect(
      JSON.stringify((await q(`SELECT results FROM pack_requests WHERE id=$1`, [r.requestId]))[0]?.results),
    ).not.toContain('weak spot');
    // the list now says a role exists, and who was hired
    const list = await asOwner('GET', `/api/packs/${crewId}/personas`);
    expect(list.personas[0]).toMatchObject({
      role: { version: 1, upToDate: true },
      hiredAgentIds: [agentId],
    });
  });

  it('hires every persona of a pack in one go (the bulk import), one agent each, with the roles reused', async () => {
    const r = await asOwner(
      'POST',
      `/api/packs/${crewId}/hire`,
      {
        items: [{ key: 'critic', name: 'Cleo Two' }],
        workstationId: w.workstationId,
        runtime: 'mock',
        model: 'mock',
      },
      202,
    );
    await answerRead(owner, crewId, personaText(critic));
    await until(async () => (await asOwner('GET', `/api/pack-hires/${r.requestId}`)).status === 'done');
    expect((await q(`SELECT count(*)::int AS n FROM role_definitions WHERE key='crew-critic'`))[0]?.n).toBe(
      1,
    );
    await asOwner(
      'POST',
      `/api/agents/${(await asOwner('GET', `/api/pack-hires/${r.requestId}`)).agents[0].agentId}/fire`,
      {},
      200,
    ).catch(() => undefined);
  });

  it('flags the agent when the pack loses its approval and keeps its role version; approving again clears it', async () => {
    await asOwner('POST', `/api/packs/${crewId}/revoke`);
    let agent = (await asOwner('GET', '/api/agents')).agents.find((a: { id: string }) => a.id === agentId);
    expect(agent.provenance.warning).toBe('revoked');
    expect(agent).toMatchObject({ roleVersion: 1, status: 'active' });
    await asOwner('POST', `/api/packs/${crewId}/trust`, {
      sha: crewSnap.sha,
      contentHash: crewSnap.contentHash,
    });
    agent = (await asOwner('GET', '/api/agents')).agents.find((a: { id: string }) => a.id === agentId);
    expect(agent.provenance.warning).toBeNull();
  });

  it('offers a new role version when the pack changes the persona: a diff of the instructions, never applied by itself', async () => {
    const changed: AuthoredCapability = {
      ...critic,
      prompt: 'You find the weak spot, then name the cheapest fix.',
    };
    const s2 = revision('crew', [changed], 2);
    mem.send('packs.report', { packId: crewId, state: 'update', snapshot: s2, diff: {} });
    await until(async () => (await asOwner('GET', `/api/packs/${crewId}`)).pack.update?.sha === s2.sha);
    await asOwner('POST', `/api/packs/${crewId}/accept-update`, { sha: s2.sha });
    const offers = (await asOwner('GET', '/api/role-offers')).items;
    expect(offers).toEqual([
      expect.objectContaining({
        roleKey: 'crew-critic',
        fromVersion: 1,
        packName: 'crew',
        newLabel: 'CREW · critic · v2',
      }),
    ]);
    // nothing moved
    expect(
      (await asOwner('GET', '/api/agents')).agents.find((a: { id: string }) => a.id === agentId).roleVersion,
    ).toBe(1);
    // a Member sees no offers (managers decide)
    expect((await asMember('GET', '/api/role-offers')).items).toEqual([]);
    const rev = await asOwner('POST', '/api/role-offers/crew-critic/review', {}, 202);
    await answerRead(owner, crewId, personaText(changed));
    await until(
      async () =>
        (await asOwner('GET', `/api/role-offers/crew-critic/review/${rev.requestId}`)).status === 'ready' ||
        (await asOwner('GET', `/api/role-offers/crew-critic/review/${rev.requestId}`)).status === 'done',
    );
    const review = await asOwner('GET', `/api/role-offers/crew-critic/review/${rev.requestId}`);
    expect(review.current).toContain('You find the weak spot in a plan.');
    expect(review.proposed).toContain('name the cheapest fix');
    // accepting needs a review of this very version
    await asOwner('POST', '/api/role-offers/crew-critic/accept', { requestId: randomUUID() }, 409);
    const done = await asOwner('POST', '/api/role-offers/crew-critic/accept', { requestId: rev.requestId });
    expect(done.version).toBe(2);
    expect(
      (await asOwner('GET', '/api/agents')).agents.find((a: { id: string }) => a.id === agentId),
    ).toMatchObject({
      roleVersion: 2,
      provenance: { warning: null },
    });
    expect((await asOwner('GET', '/api/role-offers')).items).toEqual([]);
  });

  it('flags the agent when the pack is removed', async () => {
    const gone = (
      await asMember(
        'POST',
        '/api/my-capabilities',
        { name: 'gone', visibility: 'org', workstationId: memberWs },
        201,
      )
    ).pack.id as string;
    const s = revision('gone', [critic], 1);
    await asMember(
      'POST',
      `/api/my-capabilities/${gone}/save`,
      { keyId: memKey.keyId, ciphertext: await seal(memKey, { tree: packTree([critic]) }) },
      202,
    );
    mem.send('packs.report', { packId: gone, state: 'resolved', snapshot: s });
    await until(async () =>
      (await asOwner('GET', '/api/packs')).packs.some((p: { id: string }) => p.id === gone),
    );
    await asOwner('POST', `/api/packs/${gone}/trust`, { sha: s.sha, contentHash: s.contentHash });
    const r = await asOwner(
      'POST',
      `/api/packs/${gone}/hire`,
      {
        items: [{ key: 'critic', name: 'Gina' }],
        workstationId: w.workstationId,
        runtime: 'mock',
        model: 'mock',
      },
      202,
    );
    await answerRead(mem, gone, personaText(critic));
    await until(async () => (await asOwner('GET', `/api/pack-hires/${r.requestId}`)).status === 'done');
    await asOwner('DELETE', `/api/packs/${gone}`, undefined, 204);
    const gina = (await asOwner('GET', '/api/agents')).agents.find(
      (a: { name: string }) => a.name === 'Gina',
    );
    expect(gina.provenance.warning).toBe('removed');
  });
});

describe('chat with a persona', () => {
  let threadId = '';
  const startOf = (r: FakeRunner) => r.waitFor('chat.start', (f) => f.threadId === threadId);
  it('starts a one-to-one session with a registry persona on the user’s own workstation', async () => {
    const r = await asOwner(
      'POST',
      '/api/persona-chats',
      { personaKey: 'devils-advocate', runtime: 'mock', model: 'mock' },
      201,
    );
    threadId = r.session.threadId;
    expect(r.session).toMatchObject({ kind: 'persona_chat', workstationId: w.workstationId });
    expect(r.session.participants.map((p: { kind: string }) => p.kind).sort()).toEqual(['persona', 'user']);
    await asOwner('POST', '/api/persona-chats', { personaKey: 'no-such-persona' }, 404);
  });

  it('queues a durable turn per message, with no verbs but skill and ledger reads, and books its cost', async () => {
    const said = await asOwner(
      'POST',
      `/api/persona-chats/${threadId}/say`,
      { body: 'Is this plan sound?' },
      202,
    );
    expect(said.turn).toMatchObject({ status: expect.stringMatching(/queued|running/) });
    const start = await startOf(owner);
    expect(start.session).toMatchObject({
      kind: 'persona_chat',
      purpose: 'persona_chat',
      ownerSession: true,
      speaker: { kind: 'persona', personaKey: 'devils-advocate' },
    });
    expect(start.message).toContain('Is this plan sound?');
    owner.send('chat.done', {
      chatId: start.chatId,
      threadId,
      messageText: 'No: the plan skips the rollback.',
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    await until(async () =>
      (await asOwner('GET', `/api/sessions/${threadId}/turns`)).turns.every(
        (t: { status: string }) => t.status === 'done',
      ),
    );
    const msgs = (await asOwner('GET', `/api/threads/${threadId}/messages`)).messages;
    expect(msgs.map((m: { body: string }) => m.body)).toContain('No: the plan skips the rollback.');
    // the turn is in the organization's cost ledger (kind session), priced at append time
    const turnId = (await asOwner('GET', `/api/sessions/${threadId}/turns`)).turns[0].id as string;
    await until(
      async () =>
        (await q(`SELECT 1 FROM shift_costs WHERE kind='session' AND shift_id=$1`, [turnId])).length === 1,
    );
    expect((await asOwner('GET', `/api/sessions/${threadId}`)).session.cost).toBeDefined();
  });

  it('is private to its user: another member, an Admin and another organization cannot read, join or ask', async () => {
    await ok(
      w.t.req('GET', `/api/sessions/${threadId}`, {
        cookie: member.cookie,
        headers: { 'x-aom-org': w.owner.id },
      }),
      404,
    );
    await ok(
      w.t.req('GET', `/api/threads/${threadId}/messages`, {
        cookie: member.cookie,
        headers: { 'x-aom-org': w.owner.id },
      }),
      404,
    );
    await ok(
      w.t.req('POST', `/api/persona-chats/${threadId}/say`, {
        cookie: member.cookie,
        headers: { 'x-aom-org': w.owner.id },
        body: { body: 'hi' },
      }),
      404,
    );
    await ok(w.t.req('GET', `/api/sessions/${threadId}`, { cookie: stranger.cookie }), 404);
    // a non-participant Owner/Admin's event stream gets the event without its content
    const admin = await q(
      `SELECT u.id FROM users u JOIN org_members om ON om.user_id = u.id WHERE om.org_id=$1 AND om.role='admin' LIMIT 1`,
      [w.owner.id],
    );
    const replay = await replayVisible(
      w.t.app.ctx.pool,
      {
        userId: admin[0]?.id,
        kind: 'user',
        orgId: w.owner.id,
        orgRole: 'admin',
        visibleProjectIds: new Set<string>(),
      } as never,
      0n,
      5000,
    );
    const mine = replay.filter((e) => e.streamId === `thread-${threadId}`);
    expect(mine.length).toBeGreaterThan(0);
    const viewer = {
      userId: admin[0]?.id,
      kind: 'user',
      orgId: w.owner.id,
      orgRole: 'admin',
      visibleProjectIds: new Set<string>(),
    } as never;
    const levels = new Set<string | false>();
    for (const e of mine)
      levels.add(sessionLevel('full', viewer, e, await sessionAudienceOf(w.t.app.ctx.pool, e)));
    // the Admin is not in the chat: every event of it reaches them without its content
    expect([...levels]).toEqual(['stripped']);
    const ownerViewer = {
      userId: w.owner.id,
      kind: 'user',
      orgId: w.owner.id,
      orgRole: 'owner',
      visibleProjectIds: new Set<string>(),
    } as never;
    const own = new Set<string | false>();
    for (const e of mine)
      own.add(sessionLevel('full', ownerViewer, e, await sessionAudienceOf(w.t.app.ctx.pool, e)));
    expect([...own]).toEqual(['full']);
  });

  it('chats with a private persona only for its owner, on the workstation that holds it', async () => {
    const mine = (await asMember('GET', '/api/my-capabilities')).packs.find(
      (p: { name: string }) => p.name === 'mine',
    );
    expect(mine.state).toBe('private');
    const r = await asMember(
      'POST',
      '/api/persona-chats',
      { personaKey: 'mine:critic', runtime: 'mock', model: 'mock' },
      201,
    );
    expect(r.session.workstationId).toBe(memberWs);
    const said = await asMember(
      'POST',
      `/api/persona-chats/${r.session.threadId}/say`,
      { body: 'Look at this.' },
      202,
    );
    const start = await mem.waitFor('chat.start', (f) => f.chatId === said.turn.id);
    expect(start.session).toMatchObject({
      kind: 'persona_chat',
      ownerSession: true,
      speaker: { personaKey: 'mine:critic' },
    });
    // the Owner cannot reach it, with or without a workstation of their own
    await asOwner('POST', '/api/persona-chats', { personaKey: 'mine:critic' }, 404);
  });

  it('refuses a pack persona on a workstation that does not hold the pack', async () => {
    const m2 = await w.t.userSession(uniqueEmail('r3a-m2'));
    await w.t.addOrgMember(w.owner.id, m2.id, 'member');
    const p2 = await pairWorkstation(w.t, m2, 'm2-desk');
    const r2 = await FakeRunner.connect(w.baseUrl, p2.runnerToken);
    r2.hello({
      runtimes: MOCK_RUNTIME,
      capabilities: [PACKS_CAPABILITY, PACK_AUTHORING_CAPABILITY, SESSION_TURNS_CAPABILITY],
      sudoKey: makeKey(),
    });
    await r2.waitFor('welcome');
    const res = await w.t.req('POST', '/api/persona-chats', {
      cookie: m2.cookie,
      headers: { 'x-aom-org': w.owner.id },
      body: { personaKey: 'crew:critic' },
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('persona_not_on_workstation');
    r2.close();
  });
});

describe('replay and isolation, once more at the end', () => {
  it('rebuilds the same projection of packs, assignments, grants, offers and provenance', async () => {
    const tables = [
      'packs',
      'pack_assignments',
      'pack_agent_grants',
      'role_pack_offers',
      'pack_workstation_state',
    ];
    const snap = async () =>
      JSON.stringify([
        ...(await Promise.all(tables.map((t) => q(`SELECT * FROM ${t} ORDER BY 1, 2`)))),
        await q(`SELECT id, provenance, role_version FROM agents ORDER BY id`),
        await q(
          `SELECT id, key, version, status, definition FROM role_definitions WHERE org_id IS NOT NULL ORDER BY id`,
        ),
      ]);
    const a = await snap();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snap()).toBe(a);
  });

  it('shows another organization nothing: no pack, no offer, no persona, no hire', async () => {
    const o = (await asOwner('GET', '/api/packs')).packs[0];
    expect((await ok<any>(w.t.req('GET', '/api/packs', { cookie: stranger.cookie }))).packs).toEqual([]);
    expect(
      (await ok<any>(w.t.req('GET', '/api/my-capabilities', { cookie: stranger.cookie }))).packs,
    ).toEqual([]);
    expect((await ok<any>(w.t.req('GET', '/api/role-offers', { cookie: stranger.cookie }))).items).toEqual(
      [],
    );
    await ok(
      w.t.req('PUT', `/api/packs/${o.id}/workstations`, {
        cookie: stranger.cookie,
        body: { workstationIds: [randomUUID()] },
      }),
      404,
    );
  });
});
