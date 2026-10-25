import { CLAUDE_ACCOUNTS_CAPABILITY, MENTION_WORK_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember } from './helpers/members.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, MOCK_RUNTIME, ok, until, type World } from './helpers/world.ts';

/**
 * Owner decision 2026-10-25: an @mention may edit and run commands, within what the commenter may grant (Owners and Admins: the
 * role's edit and shell; anyone else: reading) and only while the card's working folder is free. Who may mention is unchanged.
 */
let w: World;
let r: FakeRunner;
const CLAUDE = { id: 'claude-code', version: '2.1.299', available: true, capabilities: ['shell'] };
const USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
const comment = (cardId: string, body: string, cookie = w.owner.cookie) =>
  w.t.req('POST', `/api/cards/${cardId}/comments`, { cookie, body: { body } });
const answer = (start: { chatId: string; threadId: string }, text: string) =>
  r.send('chat.done', { chatId: start.chatId, threadId: start.threadId, messageText: text, usage: USAGE });
const hireClaude = (name: string, role = 'builder') =>
  w.hire(name, role, role === 'builder' ? 'junior' : 'senior', { runtime: 'claude-code', model: 'sonnet' });
const setCaps = (caps: string[]) =>
  q('UPDATE workstation_capabilities SET capabilities = $2 WHERE workstation_id=$1', [w.workstationId, caps]);

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [CLAUDE_ACCOUNTS_CAPABILITY, MENTION_WORK_CAPABILITY] });
  r.send('runtimes.report', { runtimes: [MOCK_RUNTIME[0], CLAUDE] });
  await r.barrier();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  await freshState();
  await q('TRUNCATE card_mentions, agent_mention_policy');
  await setCaps([CLAUDE_ACCOUNTS_CAPABILITY, MENTION_WORK_CAPABILITY]);
});

describe('a mention that works', () => {
  it("gives an Owner or Admin mention the role's edit and shell, but never the web, a browser or MCP", async () => {
    await hireClaude('Una');
    const card = await w.card();
    const res = await comment(card.id, '@una please fix the typo in the README');
    expect(res.body.mentions[0].status).toBe('started');
    const start = await r.waitFor('chat.start', (f) => f.threadId === card.id);
    expect(start.mentionWork).toBe(true);
    expect(start.agent.permissions.allowedTools).toEqual(expect.arrayContaining(['read', 'edit', 'shell']));
    expect(start.agent.permissions.allowedTools).not.toContain('web');
    expect(start.agent.permissions).toMatchObject({ browser: false, readOrgRepos: false });
    expect(start.context.mcpServers).toBeUndefined();
    expect(start.delegation).toBeUndefined();
    expect(start.playbookGrants).toBeUndefined();
    expect(start.message).toContain('You may edit files and run commands in this card');
    expect((await q('SELECT work FROM card_mentions'))[0]?.work).toBe(true);
    answer(start, 'Fixed the typo in README.md.');
    await until(async () => (await q(`SELECT status FROM card_mentions`))[0]?.status === 'replied');
  });

  it("keeps a Member's mention read-only, even when the agent's manager allowed members to mention it", async () => {
    const agent = await hireClaude('Una');
    const card = await w.card();
    const m = await addMember(w, 'mem');
    await ok(
      w.t.req('PUT', `/api/agents/${agent.id}/mention-policy`, {
        cookie: w.owner.cookie,
        body: { allowMembers: true },
      }),
    );
    expect((await comment(card.id, '@una fix it', m.cookie)).body.mentions[0].status).toBe('started');
    const start = await r.waitFor('chat.start', (f) => f.threadId === card.id);
    expect(start.mentionWork).toBeUndefined();
    expect(start.agent.permissions.allowedTools.every((t: string) => t === 'read')).toBe(true);
    expect(start.agent.permissions).toMatchObject({ mayCommit: false, writableGlobs: [] });
    expect(start.message).toContain('cannot edit files');
    expect((await q('SELECT work FROM card_mentions'))[0]?.work).toBe(false);
    answer(start, 'ok');
    await until(async () => (await q(`SELECT status FROM card_mentions`))[0]?.status === 'replied');
  });

  it('stays read-only for a role that never edits, and for an agent that is not on Claude Code', async () => {
    await hireClaude('Rex', 'analyst');
    await w.hire('Una', 'builder', 'junior'); // the mock runtime
    const card = await w.card();
    await comment(card.id, '@rex and @una take a look');
    for (const n of ['Rex', 'Una']) {
      const start = await r.waitFor('chat.start', (f) => f.agent.name === n && f.threadId === card.id);
      expect(start.mentionWork, n).toBeUndefined();
      expect(
        start.agent.permissions.allowedTools.every((t: string) => t === 'read'),
        n,
      ).toBe(true);
      answer(start, 'ok');
    }
    await until(
      async () =>
        (await q(`SELECT count(*)::int AS n FROM card_mentions WHERE status='replied'`))[0]?.n === 2,
    );
  });

  it('is held to reading, and told why, when the runner is too old or a shift holds the card', async () => {
    await hireClaude('Una');
    const card = await w.card();
    await setCaps([CLAUDE_ACCOUNTS_CAPABILITY]);
    await comment(card.id, '@una fix it');
    let start = await r.waitFor('chat.start', (f) => f.threadId === card.id);
    expect(start.mentionWork).toBeUndefined();
    expect(start.message).toContain('runner on its workstation is too old');
    answer(start, 'ok');
    await until(async () => (await q(`SELECT status FROM card_mentions`))[0]?.status === 'replied');
    await setCaps([CLAUDE_ACCOUNTS_CAPABILITY, MENTION_WORK_CAPABILITY]);
    await q(
      `UPDATE cards SET claim_id = gen_random_uuid(), claimed_by_agent_id = (SELECT id FROM agents LIMIT 1),
              claim_workstation_id = $2, claim_shift_id = gen_random_uuid(), claimed_at = now(),
              lease_expires_at = now() + interval '1 hour', status = 'claimed' WHERE id=$1`,
      [card.id, w.workstationId],
    );
    const from = r.received.length;
    await comment(card.id, '@una fix it now');
    start = await r.waitFor('chat.start', (f) => f.message.includes('fix it now'), 10_000, from);
    expect(start.mentionWork).toBeUndefined();
    expect(start.message).toContain('a shift holds this card right now');
    answer(start, 'ok');
  });

  it('lets only one agent work on a card from a comment at a time', async () => {
    await hireClaude('Una');
    await hireClaude('Vic');
    const card = await w.card();
    const res = await comment(card.id, '@una and @vic both fix this');
    expect(res.body.mentions.map((m: { status: string }) => m.status)).toEqual(['started', 'started']);
    const una = await r.waitFor('chat.start', (f) => f.agent.name === 'Una' && f.threadId === card.id);
    const vic = await r.waitFor('chat.start', (f) => f.agent.name === 'Vic' && f.threadId === card.id);
    expect(una.mentionWork).toBe(true);
    expect(vic.mentionWork).toBeUndefined();
    expect(vic.message).toContain('already working on this card from a comment');
    answer(una, 'done');
    answer(vic, 'done');
    await until(
      async () =>
        (await q(`SELECT count(*)::int AS n FROM card_mentions WHERE status='replied'`))[0]?.n === 2,
    );
  });

  it('keeps a shift from claiming the card while a mention works in its folder', async () => {
    await hireClaude('Una');
    await w.hire('Bo', 'builder', 'junior');
    const card = await w.card();
    await comment(card.id, '@una fix it');
    const start = await r.waitFor('chat.start', (f) => f.threadId === card.id);
    expect(start.mentionWork).toBe(true);
    const dispatcher = w.t.app.ctx.services.dispatcher;
    const pass = async (from: number) => {
      await q(`UPDATE workstations SET last_seen_at = now() WHERE connected`);
      dispatcher.cooldown.clear();
      await dispatcher.run();
      await r.barrier();
      return r.received.slice(from).filter((f) => f.type === 'shift.start');
    };
    expect(await pass(r.received.length)).toHaveLength(0);
    answer(start, 'done');
    await until(async () => (await q(`SELECT status FROM card_mentions`))[0]?.status === 'replied');
    expect((await pass(r.received.length)).length).toBeGreaterThan(0);
  });

  it('a work mention that is lost in a restart does not hold the card for ever', async () => {
    await hireClaude('Una');
    await w.hire('Bo', 'builder', 'junior');
    const card = await w.card();
    await comment(card.id, '@una fix it');
    await r.waitFor('chat.start', (f) => f.threadId === card.id);
    const dispatcher = w.t.app.ctx.services.dispatcher;
    const pass = async () => {
      const from = r.received.length;
      await q(`UPDATE workstations SET last_seen_at = now() WHERE connected`);
      dispatcher.cooldown.clear();
      await dispatcher.run();
      await r.barrier();
      return r.received.slice(from).filter((f) => f.type === 'shift.start');
    };
    expect(await pass()).toHaveLength(0);
    await q(`UPDATE card_mentions SET created_at = created_at - interval '31 minutes'`);
    expect((await pass()).length).toBeGreaterThan(0);
  });
});
