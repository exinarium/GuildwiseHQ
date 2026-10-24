import { BOARD_VERBS_CAPABILITY, SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY } from '@aom/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { CAST5, kit, q } from './helpers/sessions-r2.ts';
import { createWorld, ok, pairWorkstation, until, type World } from './helpers/world.ts';

/**
 * Revision R2: any member creates sessions, the creator manages (Owners and Admins can override, other participants talk, add
 * notes and vote), the Boardroom cast rule, option scoring, @mention jumps, archive and delete, and what a non-participant
 * Owner or Admin sees of a session's documents.
 */
let w: World;
let r: FakeRunner;
let K: ReturnType<typeof kit>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({
    capabilities: [SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY, BOARD_VERBS_CAPABILITY],
  });
  K = kit(w, () => r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});
afterEach(async () => {
  await K.cleanup();
});

let n = 0;
const member = async (role: 'member' | 'admin' = 'member') => {
  const u = await w.t.userSession(`r2-${role}-${++n}-${Date.now()}@example.test`);
  await w.t.addOrgMember(w.owner.id, u.id, role);
  return u;
};
const addToSession = (threadId: string, u: { id: string }, seat = 'guest') =>
  K.owner('POST', `/api/sessions/${threadId}/participants`, { kind: 'user', refId: u.id, seat }, 201);

describe('who creates and who manages', () => {
  it('lets any member start a discovery and a boardroom on their own workstation, and only there', async () => {
    const m = await member();
    const mine = await pairWorkstation(w.t, m, 'Member desk');
    const as = K.as(m.cookie);
    const disc = await as('POST', '/api/discovery', {
      title: 'Member idea',
      idea: 'x',
      workstationId: mine.workstationId,
    });
    expect(disc.status).toBe(201);
    expect(disc.body.state.canManage).toBe(true);
    const brd = await as('POST', '/api/board', {
      topic: 'Member topic',
      cast: CAST5,
      workstationId: mine.workstationId,
    });
    expect(brd.status).toBe(201);
    expect(brd.body.state.canManage).toBe(true);
    const row = (
      await q('SELECT workstation_id, created_by FROM threads WHERE id=$1', [brd.body.state.threadId])
    )[0];
    expect(row).toMatchObject({ workstation_id: mine.workstationId, created_by: m.id });
    // someone else's workstation is refused
    const other = await as('POST', '/api/discovery', { title: 'Borrowed', workstationId: w.workstationId });
    expect(other.status, JSON.stringify(other.body)).toBe(403);
    expect(JSON.stringify(other.body)).toContain('workstation_not_yours');
    // saved casts: any member saves one and deletes their own; others cannot delete it
    const room = await as('POST', '/api/board-rooms', {
      name: 'Mine',
      cast: CAST5.slice(0, 2).concat(CAST5.slice(2)),
    });
    expect(room.status).toBe(201);
    const m2 = await member();
    expect((await K.as(m2.cookie)('DELETE', `/api/board-rooms/${room.body.room.id}`)).status).toBe(403);
    expect((await as('DELETE', `/api/board-rooms/${room.body.room.id}`)).status).toBe(204);
  });

  it('the creator manages in full; an Admin who is in the room can override; other participants talk, add notes and vote', async () => {
    const creator = await member();
    const mine = await pairWorkstation(w.t, creator, 'Creator desk');
    const as = K.as(creator.cookie);
    const st = (
      await as('POST', '/api/board', {
        topic: 'Ownership',
        cast: CAST5,
        roundCap: 3,
        workstationId: mine.workstationId,
      })
    ).body.state;
    const id = st.threadId;
    const admin = await member('admin');
    const guest = await member();
    const outsider = await member();
    for (const u of [admin, guest]) {
      const added = await as('POST', `/api/sessions/${id}/participants`, {
        kind: 'user',
        refId: u.id,
        seat: 'guest',
      });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
    }
    const asAdmin = K.as(admin.cookie);
    const asGuest = K.as(guest.cookie);
    // not in the room: not even visible
    expect((await K.as(outsider.cookie)('GET', `/api/board/${id}`)).status).toBe(404);
    // state flags
    expect((await as('GET', `/api/board/${id}`)).body.state.canManage).toBe(true);
    expect((await asAdmin('GET', `/api/board/${id}`)).body.state.canManage).toBe(true);
    expect((await asGuest('GET', `/api/board/${id}`)).body.state.canManage).toBe(false);
    // the guest cannot steer
    for (const [m, u, b] of [
      ['POST', `/api/board/${id}/pause`, undefined],
      ['POST', `/api/board/${id}/end`, undefined],
      ['POST', `/api/board/${id}/minutes`, undefined],
      ['POST', `/api/board/${id}/pull-into-prd`, undefined],
      ['PATCH', `/api/board/${id}`, { budgetUsd: 5 }],
      ['POST', `/api/sessions/${id}/archive`, { archived: true }],
      ['DELETE', `/api/sessions/${id}`, undefined],
    ] as const)
      expect((await asGuest(m, u, b)).status, `${m} ${u}`).toBe(403);
    // but talks, adds a note and votes
    expect((await asGuest('POST', `/api/board/${id}/say`, { body: 'my view' })).status).toBe(201);
    const noted = await asGuest('POST', `/api/board/${id}/notes`, { column: 'ideas', text: 'guest idea' });
    expect(noted.status).toBe(201);
    const noteId = noted.body.state.notes.find((x: any) => x.text === 'guest idea').id;
    expect((await asGuest('POST', `/api/board/${id}/notes/${noteId}/vote`)).status).toBe(200);
    // whiteboard edit, merge and delete belong to the managers
    expect((await asGuest('PATCH', `/api/board/${id}/notes/${noteId}`, { text: 'changed' })).status).toBe(
      403,
    );
    expect((await asGuest('DELETE', `/api/board/${id}/notes/${noteId}`)).status).toBe(403);
    expect(
      (await as('PATCH', `/api/board/${id}/notes/${noteId}`, { text: 'edited by creator' })).status,
    ).toBe(200);
    // the Admin overrides
    expect((await asAdmin('POST', `/api/board/${id}/pause`)).status).toBe(200);
    expect((await asAdmin('POST', `/api/board/${id}/resume`)).status).toBe(200);
    expect((await asAdmin('DELETE', `/api/board/${id}/notes/${noteId}`)).status).toBe(200);
  });

  it("discovery: answers, phase, drafts and panel edits are the creator's; a participant can talk and add notes", async () => {
    const creator = await member();
    const mine = await pairWorkstation(w.t, creator, 'Disc desk');
    const as = K.as(creator.cookie);
    const s = (
      await as('POST', '/api/discovery', { title: 'Own disc', idea: 'y', workstationId: mine.workstationId })
    ).body.state;
    const guest = await member();
    expect(
      (
        await as('POST', `/api/sessions/${s.threadId}/participants`, {
          kind: 'user',
          refId: guest.id,
          seat: 'guest',
        })
      ).status,
    ).toBe(201);
    const asGuest = K.as(guest.cookie);
    expect((await asGuest('GET', `/api/discovery/${s.threadId}`)).body.state.canManage).toBe(false);
    expect((await as('GET', `/api/discovery/${s.threadId}`)).body.state.canManage).toBe(true);
    expect((await asGuest('POST', `/api/discovery/${s.threadId}/phase`, { phase: 'diverge' })).status).toBe(
      403,
    );
    expect((await asGuest('POST', `/api/discovery/${s.threadId}/pause`)).status).toBe(403);
    expect((await asGuest('POST', `/api/discovery/${s.threadId}/hand-to-ba`)).status).toBe(403);
    expect((await asGuest('POST', `/api/discovery/${s.threadId}/draft`, { kind: 'prd' })).status).toBe(403);
    expect((await asGuest('POST', `/api/discovery/${s.threadId}/say`, { body: 'hello' })).status).toBe(201);
    const added = await asGuest('POST', `/api/discovery/${s.threadId}/notes`, {
      section: 'ideas',
      text: 'a guest idea',
    });
    expect(added.status).toBe(201);
    const noteId = added.body.state.notes.find((x: any) => x.text === 'a guest idea').id;
    expect(
      (await asGuest('PATCH', `/api/discovery/${s.threadId}/notes/${noteId}`, { text: 'x' })).status,
    ).toBe(403);
    expect((await asGuest('DELETE', `/api/discovery/${s.threadId}/notes/${noteId}`)).status).toBe(403);
    expect(
      (await as('PATCH', `/api/discovery/${s.threadId}/notes/${noteId}`, { text: 'tidied' })).status,
    ).toBe(200);
    expect((await as('DELETE', `/api/discovery/${s.threadId}/notes/${noteId}`)).status).toBe(200);
  });
});

describe('the Boardroom cast', () => {
  it("always has the Optimist and the Devil's Advocate plus 3 to 4 other seats", async () => {
    const bad = (cast: unknown) => K.raw('POST', '/api/board', { topic: 't', cast });
    // missing a fixed seat
    let res = await bad(
      CAST5.filter((c) => c.refId !== 'optimist').concat([{ kind: 'persona', refId: 'ops' }]),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Optimist');
    res = await bad(
      CAST5.filter((c) => c.refId !== 'devils-advocate').concat([{ kind: 'persona', refId: 'ops' }]),
    );
    expect(res.status).toBe(400);
    // too few or too many others
    expect((await bad(CAST5.slice(0, 4))).status).toBe(400);
    const six = CAST5.concat([
      { kind: 'persona', refId: 'ops' },
      { kind: 'persona', refId: 'customer-smb' },
    ]);
    expect((await bad(six)).status).toBe(400);
    // six seats (four others) are fine, with the fixed seat labels whatever the client says
    const st = (
      await K.owner(
        'POST',
        '/api/board',
        {
          topic: 'Cast rule',
          cast: CAST5.concat([{ kind: 'persona', refId: 'ops' }]).map((c) =>
            c.refId === 'optimist' ? { ...c, seat: 'Panelist' } : c,
          ),
        },
        201,
      )
    ).state;
    expect(st.cast).toHaveLength(6);
    expect(st.cast.find((c: any) => c.refId === 'optimist').seat).toBe('Optimist');
    expect(st.cast.find((c: any) => c.refId === 'devils-advocate').seat).toBe("Devil's Advocate");
    // the fixed seats cannot be removed
    const part = (
      await q(`SELECT id FROM thread_participants WHERE thread_id=$1 AND ref_id='optimist'`, [st.threadId])
    )[0];
    const del = await K.raw('DELETE', `/api/sessions/${st.threadId}/participants/${part.id}`);
    expect(del.status).toBe(409);
    expect(JSON.stringify(del.body)).toContain('fixed_seat');
    // the Optimist is a built-in persona and speaks with its own text
    const start = await K.nextStart(st.threadId, (f) => f.session?.speaker?.personaKey === 'optimist');
    expect(start.session.instructions).toContain('Optimist on a decision panel');
  });

  it('starting from "Suggest a cast" follows the same rule, and the suggestion asks for 3 to 4 others', async () => {
    const sug = (await K.owner('POST', '/api/board/suggest', { topic: 'Pick a cast' }, 201)).state;
    const ask = await K.nextStart(sug.threadId, K.role('cast'));
    expect(ask.message).toContain('three or four');
    expect(ask.message).toContain('fixed seats');
    expect(
      (await K.raw('POST', `/api/board/${sug.threadId}/start`, { topic: 'x', cast: CAST5.slice(0, 3) }))
        .status,
    ).toBe(400);
    const go = await K.raw('POST', `/api/board/${sug.threadId}/start`, { topic: 'Pick a cast', cast: CAST5 });
    expect(go.status).toBe(200);
    expect(go.body.state.cast).toHaveLength(5);
  });
});

describe('option scoring, the tally', () => {
  it('records one score per option and seat, tallies them on the board and in the minutes, and hides round 1 until revealed', async () => {
    const st = await K.createBoard({
      format: 'option_scoring',
      brief: 'Options: Alpha, Beta, Gamma',
      roundCap: 2,
    });
    const starts: any[] = [];
    for (let i = 0; i < 4; i++) starts.push(await K.nextStart(st.threadId, K.role('speaker')));
    expect(starts[0].message).toContain('aom board score');
    const opt = starts.find((x) => x.session.speaker.personaKey === 'optimist');
    const dev = starts.find((x) => x.session.speaker.personaKey === 'devils-advocate');
    expect(
      (await K.call(opt.chatId, 'board.score', { option: 'Alpha', score: 5, why: 'big upside' })).ok,
    ).toBe(true);
    expect((await K.call(opt.chatId, 'board.score', { option: 'Beta', score: 3 })).ok).toBe(true);
    expect((await K.call(dev.chatId, 'board.score', { option: 'alpha', score: 2, why: 'risky' })).ok).toBe(
      true,
    );
    // scoring again replaces
    expect((await K.call(opt.chatId, 'board.score', { option: 'Beta', score: 4 })).ok).toBe(true);
    // out of range or not a number is refused
    expect((await K.call(opt.chatId, 'board.score', { option: 'Alpha', score: 9 })).ok).toBe(false);
    // sealed: the owner sees no scores before the reveal
    expect((await K.board(st.threadId)).scores).toEqual([]);
    for (const x of starts) await K.finish(x);
    await K.finish(await K.nextStart(st.threadId, K.role('speaker')));
    await until(async () => (await K.board(st.threadId)).config.revealedRound === 1);
    const s = await K.board(st.threadId);
    expect(s.scores.map((x: any) => [x.option, x.total])).toEqual([
      ['Alpha', 7],
      ['Beta', 4],
    ]);
    expect(s.scores[0].scores.map((x: any) => x.score).sort()).toEqual([2, 5]);
    // minutes carry the tally
    await K.owner('POST', `/api/board/${st.threadId}/end`);
    const min = await K.nextStart(st.threadId, K.role('minutes'));
    await K.call(min.chatId, 'board.minutes', {
      content: '## Positions\n\n- a\n## Agreements\n\n- b\n## Open questions\n\n- c',
    });
    await K.finish(min);
    await until(async () => (await K.board(st.threadId)).config.stage === 'ended');
    const doc = (await K.owner('GET', `/api/documents/${(await K.board(st.threadId)).config.minutesDocId}`))
      .document;
    expect(doc.content).toContain('## Option scores');
    expect(doc.content).toMatch(/\| Alpha \|.*\| 7 \|/);
    // replay-safe
    const before = await q(
      'SELECT option, participant_id, score FROM board_scores WHERE thread_id=$1 ORDER BY 1,2',
      [st.threadId],
    );
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect(
      await q('SELECT option, participant_id, score FROM board_scores WHERE thread_id=$1 ORDER BY 1,2', [
        st.threadId,
      ]),
    ).toEqual(before);
  });

  it('refuses scoring in a format that does not score', async () => {
    const st = await K.createBoard();
    const s1 = await K.nextStart(st.threadId, K.role('speaker'));
    const res = await K.call(s1.chatId, 'board.score', { option: 'A', score: 3 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/option-scoring/);
  });
});

describe('@mentions jump into the round in progress', () => {
  it('moves a mentioned seat that has not spoken in the round to speak next; one that already spoke waits for the next pick', async () => {
    const st = await K.createBoard({ roundCap: 4 });
    const starts: any[] = [];
    for (let i = 0; i < 4; i++) starts.push(await K.nextStart(st.threadId, K.role('speaker')));
    for (const x of starts) await K.finish(x);
    await K.finish(await K.nextStart(st.threadId, K.role('speaker')));
    const slug = (key: string) => st.cast.find((c: any) => c.refId === key).slug as string;
    const chair = await K.nextStart(st.threadId, K.role('chair'));
    expect(
      (
        await K.call(chair.chatId, 'board.next', {
          speakers: [slug('user-advocate'), slug('security')],
          reason: 'x',
        })
      ).ok,
    ).toBe(true);
    await K.finish(chair);
    // round 2: the user advocate is running; the owner mentions the Optimist (not in the plan) and the user advocate
    const first = await K.nextStart(st.threadId, K.role('speaker'));
    expect(first.session.speaker.personaKey).toBe('user-advocate');
    const said = await K.owner(
      'POST',
      `/api/board/${st.threadId}/say`,
      { body: `@${slug('optimist')} and @${slug('user-advocate')} what now?` },
      201,
    );
    expect(said.mentioned).toHaveLength(2);
    const mid = await K.board(st.threadId);
    expect(mid.rounds.find((x: any) => x.round === 2).speakers.map((x: any) => x.name)).toEqual([
      'User Advocate',
      'Optimist',
      'Security',
    ]);
    // the one that already has a turn this round is kept for the next Chair pick
    const cfg = (await q('SELECT session_config FROM threads WHERE id=$1', [st.threadId]))[0].session_config;
    expect(cfg.mentions).toHaveLength(1);
    await K.finish(first);
    const second = await K.nextStart(st.threadId, K.role('speaker'));
    expect(second.session.speaker.personaKey).toBe('optimist');
    await K.finish(second);
    const third = await K.nextStart(st.threadId, K.role('speaker'));
    expect(third.session.speaker.personaKey).toBe('security');
    await K.finish(third);
    // the mention that waited is told to the Chair, and the user advocate may speak again (the owner asked)
    const chair2 = await K.nextStart(st.threadId, K.role('chair'));
    expect(chair2.message).toContain('The owner @mentioned');
    expect(
      (await K.call(chair2.chatId, 'board.next', { speakers: [slug('cost-hawk')], reason: 'y' })).ok,
    ).toBe(true);
    const r3 = (await K.board(st.threadId)).rounds.find((x: any) => x.round === 3);
    expect(r3.speakers[0].name).toBe('User Advocate');
    await K.finish(chair2);
  });
});

describe('archive and delete', () => {
  it('an archived session is read-only for everyone until it is reopened', async () => {
    const s = await K.createDiscovery();
    await K.finish(await K.nextStart(s.threadId, K.role('facilitator')));
    const res = await K.owner('POST', `/api/sessions/${s.threadId}/archive`, { archived: true });
    expect(res.session.config.archived).toBe(true);
    expect((await K.discovery(s.threadId)).config.archived).toBe(true);
    for (const [m, u, b] of [
      ['POST', `/api/discovery/${s.threadId}/say`, { body: 'hi' }],
      ['POST', `/api/discovery/${s.threadId}/notes`, { section: 'ideas', text: 'n' }],
      ['POST', `/api/sessions/${s.threadId}/messages`, { body: 'hi', kind: 'chat' }],
      ['POST', `/api/discovery/${s.threadId}/pause`, undefined],
    ] as const)
      expect((await K.raw(m, u, b)).status, `${m} ${u}`).toBe(409);
    // reading still works
    expect((await K.raw('GET', `/api/threads/${s.threadId}/messages`)).status).toBe(200);
    await K.owner('POST', `/api/sessions/${s.threadId}/archive`, { archived: false });
    expect((await K.raw('POST', `/api/discovery/${s.threadId}/say`, { body: 'hi' })).status).toBe(201);
    await K.finish(await K.nextStart(s.threadId, K.role('facilitator')));
  });

  it('delete is a tombstone: the session and its messages vanish from lists and queries, running turns are cancelled, replay keeps it hidden', async () => {
    const st = await K.createBoard();
    const four: any[] = [];
    for (let i = 0; i < 4; i++) four.push(await K.nextStart(st.threadId, K.role('speaker')));
    const running = four[0];
    const guest = await member();
    await addToSession(st.threadId, guest);
    await new Promise((res) => setTimeout(res, 500));
    const startedBefore = K.startedSince(st.threadId).length;
    expect((await K.as(guest.cookie)('DELETE', `/api/sessions/${st.threadId}`)).status).toBe(403);
    expect((await K.raw('DELETE', `/api/sessions/${st.threadId}`)).status).toBe(204);
    for (const url of [
      `/api/sessions/${st.threadId}`,
      `/api/board/${st.threadId}`,
      `/api/threads/${st.threadId}/messages`,
    ])
      expect((await K.raw('GET', url)).status, url).toBe(404);
    const list = (await K.owner('GET', '/api/sessions?kind=boardroom')).sessions as any[];
    expect(list.some((x) => x.threadId === st.threadId)).toBe(false);
    expect((await K.as(guest.cookie)('GET', `/api/board/${st.threadId}`)).status).toBe(404);
    const ev = await q(
      `SELECT type FROM events WHERE type='SessionThreadDeleted' AND payload->>'threadId'=$1`,
      [st.threadId],
    );
    expect(ev).toHaveLength(1);
    // the running turn was told to stop; the sweep does not bring the session back
    await until(async () =>
      r.received.some((f: any) => f.type === 'chat.cancel' && f.chatId === running.chatId),
    );
    await w.t.app.ctx.services.board.sweep();
    expect((await K.quiet(st.threadId)).length).toBe(startedBefore);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect((await K.raw('GET', `/api/board/${st.threadId}`)).status).toBe(404);
    expect(
      (await q('SELECT deleted_at FROM threads WHERE id=$1', [st.threadId]))[0].deleted_at,
    ).not.toBeNull();
  });
});

describe('documents of a session in the live event stream', () => {
  it('an Owner or Admin who is not in the session gets its document events without their payload', async () => {
    const admin = await member('admin');
    const mine = await Browser.open(w.baseUrl, w.owner.cookie, undefined, w.owner.id);
    const other = await Browser.open(w.baseUrl, admin.cookie, undefined, w.owner.id);
    await mine.hello();
    await other.hello();
    const s = await K.createDiscovery({ title: 'Docs privacy' });
    const start = await K.nextStart(s.threadId, K.role('facilitator'));
    expect(
      (await K.call(start.chatId, 'session.draft', { kind: 'prd', content: '# PRD\n\nSECRET-PRD-TEXT' })).ok,
    ).toBe(true);
    await K.finish(start);
    // an ordinary document, not from a session, is still visible to the Admin in full
    await K.owner(
      'POST',
      '/api/documents',
      { kind: 'brief', title: 'Plain doc', content: 'PLAIN-TEXT' },
      201,
    );
    await mine.until(() =>
      mine.events().some((e) => e.type === 'DocumentCreated' && e.payload?.title === 'Plain doc'),
    );
    await other.until(() => other.events().some((e) => e.type === 'DocumentCreated'));
    await mine.barrier();
    await other.barrier();
    const docEvents = (b: Browser) => b.events().filter((e) => String(e.type).startsWith('Document'));
    expect(JSON.stringify(mine.msgs)).toContain('SECRET-PRD-TEXT');
    expect(JSON.stringify(other.msgs)).not.toContain('SECRET-PRD-TEXT');
    const session = docEvents(other).filter(
      (e) => e.type === 'DocumentVersionSaved' && Object.keys(e.payload).length === 0,
    );
    expect(session.length).toBeGreaterThan(0);
    expect(JSON.stringify(other.msgs)).toContain('PLAIN-TEXT');
    mine.close();
    other.close();
  });
});
