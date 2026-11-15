import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_SHIFT_ENV_FILE, SHIFT_ENV_POINTER, sessionEnvRoot } from '../src/session/shift-credential.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp } from './helpers.ts';
import { ceoChatStart, FakeChatAdapter } from './owner-helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
if (!builder) throw new Error('role');

type Seen = { file?: string; existed?: boolean; content?: Record<string, string>; token?: string };
const look = (env: Record<string, string>, seen: Seen) => {
  seen.file = env[SHIFT_ENV_POINTER];
  seen.token = env.AOM_SHIFT_TOKEN;
  seen.existed = !!seen.file && existsSync(seen.file);
  if (seen.existed) seen.content = JSON.parse(readFileSync(seen.file as string, 'utf8'));
};
const entries = (root: string) => (existsSync(sessionEnvRoot(root)) ? readdirSync(sessionEnvRoot(root)) : []);

describe('session env file lifecycle', () => {
  it('a shift gets the pointer and the file; the file is gone after a normal end', async () => {
    const seen: Seen = {};
    const adapter = new ScriptedAdapter(async (i, ctl) => {
      look(i.env, seen);
      await ctl.post('/v1/report', {
        report: { kind: 'outcome', outcomeId: 'handoff', note: 'n', data: {} },
      });
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    await h.runShift({ stage: 'build' });
    expect(seen.file?.startsWith(sessionEnvRoot(h.dataDir))).toBe(true);
    expect(seen.existed).toBe(true);
    expect(seen.content?.AOM_SHIFT_TOKEN).toBe(seen.token);
    expect(existsSync(seen.file as string)).toBe(false);
    expect(entries(h.dataDir)).toEqual([]);
  });

  it('the file is gone after a failed shift (the runtime throws)', async () => {
    const seen: Seen = {};
    const adapter = new ScriptedAdapter(async (i) => {
      look(i.env, seen);
      throw new Error('runtime crashed');
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    await h.runShift({ stage: 'build' });
    expect(seen.existed).toBe(true);
    expect(existsSync(seen.file as string)).toBe(false);
  });

  it('the file is gone after a killed shift', async () => {
    const seen: Seen = {};
    const adapter = new ScriptedAdapter(async (i, ctl) => {
      look(i.env, seen);
      await new Promise<void>((resolve) => ctl.signal.addEventListener('abort', () => resolve()));
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    const run = h.runShift({ stage: 'build' });
    const hh = h;
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (seen.file) {
          clearInterval(t);
          resolve();
        }
      }, 20);
    });
    await hh.runner.supervisor.stopAll('manager');
    await run;
    expect(seen.existed).toBe(true);
    expect(existsSync(seen.file as string)).toBe(false);
  });

  it('a chat and a CEO owner turn get the pointer; no shift-env.json in the turn dir; files removed at the end', async () => {
    h = await startHarness();
    const adapter = new FakeChatAdapter();
    const chat: Seen = {};
    const owner: Seen & { turnDir?: string } = {};
    const origChat = adapter.startChat.bind(adapter);
    adapter.startChat = (async (i: { env: Record<string, string> }) => {
      look(i.env, chat);
      return origChat(i as never);
    }) as never;
    const origOwner = adapter.startOwnerTurn.bind(adapter);
    adapter.startOwnerTurn = (async (i: { env: Record<string, string>; turnDir: string }) => {
      look(i.env, owner);
      owner.turnDir = i.turnDir;
      return origOwner(i as never);
    }) as never;
    h.runner.chat.deps.adapters.set('mock', adapter);
    (h.runner as unknown as { opts: { config: { ceo: unknown } } }).opts.config.ceo = {
      fullPower: true,
      ownerPermissions: 'bypass',
    };

    const c = {
      chatId: uuidv7(),
      threadId: uuidv7(),
      agent: {
        agentId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
        name: 'Ada',
        roleKey: 'builder',
        seniority: 'junior',
        runtime: 'mock',
        model: 'mock',
        skills: [],
        permissions: builder.permissions,
        isDevops: false,
      },
      message: 'hi',
      context: {},
    };
    h.server.send('chat.start', c);
    await h.server.waitFor('chat.done', (d) => d.chatId === c.chatId);
    expect(chat.existed).toBe(true);
    expect(chat.content?.AOM_SHIFT_ID).toBe(c.chatId);

    const m = ceoChatStart('status?', { ceoMode: 'owner' });
    h.server.send('chat.start', m);
    await h.server.waitFor('chat.done', (d) => d.chatId === m.chatId);
    expect(owner.existed).toBe(true);
    expect(owner.content?.AOM_CEO_TURN_DIR).toBe(owner.turnDir);
    expect(existsSync(join(owner.turnDir as string, LEGACY_SHIFT_ENV_FILE))).toBe(false);

    const hh = h;
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (hh.runner.chat.size === 0) {
          clearInterval(t);
          resolve();
        }
      }, 20);
    });
    expect(existsSync(chat.file as string)).toBe(false);
    expect(existsSync(owner.file as string)).toBe(false);
  });

  it('runner stop and start sweep env files left behind', async () => {
    h = await startHarness();
    const leftover = join(sessionEnvRoot(h.dataDir), 'crashed.12345678');
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, 'env.json'), '{}');
    await h.runner.stop();
    expect(existsSync(leftover)).toBe(false);
    mkdirSync(leftover, { recursive: true });
    await h.runner.start();
    expect(existsSync(leftover)).toBe(false);
  });
});
