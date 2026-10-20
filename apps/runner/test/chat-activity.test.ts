import { CHAT_ACTIVITY_FEATURE, BUILTIN_ROLES, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeEvent } from '../src/adapters/types.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp } from './helpers.ts';
import { FakeChatAdapter } from './owner-helpers.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
if (!builder) throw new Error('role');
const start = () => ({
  chatId: uuidv7(),
  threadId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
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
  message: 'go',
  context: {},
});

const script: RuntimeEvent[] = [
  { kind: 'thinking' },
  { kind: 'textstart' },
  { kind: 'delta', text: 'Let me look.' },
  { kind: 'tool', name: 'Read', summary: 'apps/web/src/App.tsx', id: 't1' },
  { kind: 'toolresult', id: 't1', bytes: 10 },
  { kind: 'tool', name: 'Bash', summary: 'rm -rf /', id: 't2' },
  { kind: 'toolresult', id: 't2', bytes: 5, isError: true, refused: true },
  { kind: 'tool', name: 'Bash', summary: 'false', id: 't3' },
  { kind: 'toolresult', id: 't3', bytes: 5, isError: true },
  { kind: 'textstart' },
  { kind: 'delta', text: 'Found ' },
  { kind: 'delta', text: 'it.' },
];

async function run(features?: string[]) {
  h = await startHarness(features ? { features } : {});
  const adapter = new FakeChatAdapter();
  adapter.script = script;
  adapter.scriptFinal = 'Found it.';
  h.runner.chat.deps.adapters.set('mock', adapter);
  const msg = start();
  h.server.send('chat.start', msg);
  const done = await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
  return { done, activity: h.server.of('chat.activity').filter((a) => a.chatId === msg.chatId) };
}

describe('chat activity on the runner', () => {
  it('streams tool activity and sends the ordered turn in chat.done', async () => {
    const { done, activity } = await run([CHAT_ACTIVITY_FEATURE]);
    expect(h?.server.invalid).toEqual([]);
    expect(activity.map((a) => [a.seq, a.segment.type, a.replace ?? false])).toEqual([
      [0, 'thinking', false],
      [1, 'text', false],
      [2, 'tool', false],
      [2, 'tool', true],
      [3, 'tool', false],
      [3, 'tool', true],
      [4, 'tool', false],
      [4, 'tool', true],
      [5, 'text', false],
    ]);
    expect(done.segments).toEqual([
      { type: 'thinking' },
      { type: 'text', text: 'Let me look.' },
      { type: 'tool', id: 't1', name: 'Read', summary: 'apps/web/src/App.tsx', status: 'ok' },
      { type: 'tool', id: 't2', name: 'Bash', summary: 'rm -rf /', status: 'refused' },
      { type: 'tool', id: 't3', name: 'Bash', summary: 'false', status: 'error' },
      { type: 'text', text: 'Found it.' },
    ]);
    expect(done.messageText).toBe('Found it.');
  });

  it('sends no chat.activity to a server that did not announce it, but still sends segments', async () => {
    const { done, activity } = await run();
    expect(activity).toEqual([]);
    expect(done.segments?.length).toBe(6);
  });
});
