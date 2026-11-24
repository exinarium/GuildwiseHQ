import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { holdWorktree } from '../src/adapters/sandbox-placeholders.ts';
import type { RuntimeEvent, RuntimeSession } from '../src/adapters/types.ts';
import { floorDenies, PRIVATE_ENTRIES } from '../src/ceo/turn-files.ts';
import { type Harness, startHarness, worktreeOf } from './harness.ts';
import { cleanupTmp, sh } from './helpers.ts';
import { ceoChatStart, FakeChatAdapter, THREAD } from './owner-helpers.ts';

/**
 * runner-authority-fixes T8 (AC10) and T9 (AC11): a CEO full-power turn and a DevOps chat run unsandboxed. Neither may
 * change a card's folder: the turn's floor denies it, a server-chosen folder inside the card worktrees is refused, and
 * whatever a turn changed there anyway is reverted when it ends, on every exit (a usage limit included), with an audit
 * entry and one sentence in the reply or the error. A worktree a shift used meanwhile is left alone.
 */

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const devopsRole = BUILTIN_ROLES.find((r) => r.key === 'devops');
const devopsChat = (message: string) => ({
  chatId: uuidv7(),
  threadId: THREAD,
  agent: {
    agentId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d1',
    name: 'Forge',
    roleKey: 'devops',
    seniority: 'senior',
    runtime: 'mock',
    model: 'sonnet',
    skills: [],
    permissions: devopsRole?.permissions,
    isDevops: true,
  },
  message,
  context: { orgId: '019e3f6a-7b1c-7a2d-8c3e-0123456789e1' },
});

/** A harness with one card worktree (a finished build shift) and the fake chat runtime. */
async function withCardWorktree() {
  h = await startHarness();
  await h.runShift({ stage: 'build', ref: 'TOY-1' });
  const wt = worktreeOf(h);
  const adapter = new FakeChatAdapter();
  h.runner.chat.deps.adapters.set('mock', adapter);
  (h.runner as unknown as { opts: { config: { ceo: { fullPower: boolean } } } }).opts.config.ceo = {
    fullPower: true,
  };
  return { wt, adapter, head: sh(wt, 'git', ['rev-parse', 'HEAD']) };
}

/** The turn "does" something in the card worktree before the runtime session runs. */
function tamper(wt: string) {
  writeFileSync(join(wt, 'by-the-turn.txt'), 'x\n');
  sh(wt, 'git', ['add', '-A']);
  sh(wt, 'git', ['commit', '-m', 'turn commit']);
  writeFileSync(join(wt, 'README.md'), '# edited by the turn\n');
}

describe('AC10: a CEO full-power turn cannot change a card worktree', () => {
  it('the floor denies Edit and Write of the card worktrees and names them, the ledger and the conflicts for Bash', () => {
    const d = floorDenies({ runnerRoots: ['/data/r'], pid: 1, home: '/home/u' });
    for (const tool of ['Edit', 'Write']) expect(d).toContain(`${tool}(//data/r/worktrees/**)`);
    expect(d).toContain('Bash(*/data/r/worktrees*)');
    for (const e of ['worktrees', 'conflicts.json', 'card-branches.json', 'toolchains.json'])
      expect(PRIVATE_ENTRIES).toContain(e);
  });

  it('a turn whose folder (or an added folder) is inside a card worktree is refused before it starts', async () => {
    const { wt, adapter } = await withCardWorktree();
    for (const over of [{ cwd: wt }, { addDirs: [join(wt, 'src')] }]) {
      const m = ceoChatStart('fix it', { ceoMode: 'owner', ...over });
      h?.server.send('chat.start', m);
      const err = await h?.server.waitFor('chat.error', (e) => e.chatId === m.chatId);
      expect(String(err?.error)).toMatch(/never works in a card's folder/);
    }
    expect(adapter.ownerTurns).toHaveLength(0);
  }, 90_000);

  it('a full-power write and commit in a card worktree are reverted, and the reply says so', async () => {
    const { wt, adapter, head } = await withCardWorktree();
    const orig = adapter.startOwnerTurn.bind(adapter);
    adapter.startOwnerTurn = async (input) => {
      tamper(wt);
      return orig(input);
    };
    const m = ceoChatStart('fix the card', { ceoMode: 'owner' });
    h?.server.send('chat.start', m);
    const done = await h?.server.waitFor('chat.done', (d) => d.chatId === m.chatId);
    expect(adapter.ownerTurns).toHaveLength(1);
    expect(sh(wt, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(existsSync(join(wt, 'by-the-turn.txt'))).toBe(false);
    expect(sh(wt, 'git', ['status', '--porcelain'])).toBe('');
    expect(String(done?.messageText)).toMatch(/changed a card's folder.*put it back/);
  }, 90_000);
});

describe("AC11: a DevOps chat's change in a card worktree is reverted and reported, as for shifts", () => {
  it('a commit and an edit are reverted on chat.done, with an audit entry and a note', async () => {
    const { wt, adapter, head } = await withCardWorktree();
    const orig = adapter.startChat.bind(adapter);
    adapter.startChat = async (input) => {
      tamper(wt);
      return orig(input);
    };
    const m = devopsChat('install it in the card');
    h?.server.send('chat.start', m);
    const done = await h?.server.waitFor('chat.done', (d) => d.chatId === m.chatId);
    expect(adapter.chats).toHaveLength(1);
    expect(sh(wt, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(sh(wt, 'git', ['status', '--porcelain'])).toBe('');
    expect(String(done?.messageText)).toMatch(/changed a card's folder/);
    // the refused commit is kept under refs/guildwise/refused/
    expect(sh(wt, 'git', ['for-each-ref', 'refs/guildwise/refused'])).not.toBe('');
    const audit = await h?.server.waitFor('devops.audit', (a) =>
      (a.entries as Array<{ rule: string; kind: string }>).some(
        (e) => e.rule === 'card_worktree' && e.kind === 'chat',
      ),
    );
    expect(audit).toBeTruthy();
  }, 90_000);

  it('a turn that ends on the usage limit is reverted too, and the error says so', async () => {
    const { wt, adapter, head } = await withCardWorktree();
    adapter.startChat = async (input) => {
      adapter.chats.push(input);
      tamper(wt);
      async function* gen(): AsyncGenerator<RuntimeEvent> {
        yield { kind: 'session', runtimeSessionId: 's' };
        yield {
          kind: 'exit',
          code: 1,
          usageLimit: { until: new Date(Date.now() + 3_600_000).toISOString() },
        };
      }
      return {
        events: () => gen(),
        stop: async () => {},
        usage: () => undefined,
      } as unknown as RuntimeSession;
    };
    const m = devopsChat('install it in the card');
    h?.server.send('chat.start', m);
    const err = await h?.server.waitFor('chat.error', (e) => e.chatId === m.chatId);
    expect(String(err?.error)).toMatch(/usage limit/);
    expect(String(err?.error)).toMatch(/changed a card's folder/);
    expect(sh(wt, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(sh(wt, 'git', ['status', '--porcelain'])).toBe('');
  }, 90_000);

  it('a worktree a shift used during the chat is left alone', async () => {
    const { wt, adapter } = await withCardWorktree();
    const orig = adapter.startChat.bind(adapter);
    let release: (() => void) | undefined;
    adapter.startChat = async (input) => {
      release = holdWorktree(wt, 'another-shift');
      tamper(wt);
      return orig(input);
    };
    const m = devopsChat('look around');
    h?.server.send('chat.start', m);
    const done = await h?.server.waitFor('chat.done', (d) => d.chatId === m.chatId);
    release?.();
    expect(existsSync(join(wt, 'by-the-turn.txt'))).toBe(true);
    expect(String(done?.messageText)).not.toMatch(/card's folder/);
  }, 90_000);
});
