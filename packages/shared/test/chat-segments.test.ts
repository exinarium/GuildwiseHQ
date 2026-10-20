import { describe, expect, it } from 'vitest';
import {
  BrowserChatActivitySchema,
  CHAT_SEGMENTS_MAX,
  CHAT_TURN_TEXT_MAX,
  ChatActivitySchema,
  ChatDoneSchema,
  type ChatSegment,
  capChatSegments,
  chatSegmentsText,
  makeEnvelope,
  ServerToBrowserSchema,
  WelcomeSchema,
} from '../src/index.ts';

const THREAD = '019e3f6a-7b1c-7a2d-8c3e-0123456789c1';
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('chat segments', () => {
  it('accepts chat.activity and an optional segments list in chat.done', () => {
    const segment = { type: 'tool', id: 't', name: 'Read', summary: 'a.ts', status: 'running' };
    expect(
      ChatActivitySchema.safeParse(
        makeEnvelope('chat.activity', { chatId: 'c', threadId: THREAD, seq: 2, segment, replace: true }),
      ).success,
    ).toBe(true);
    const done = { chatId: 'c', threadId: THREAD, messageText: 'x', usage };
    expect(ChatDoneSchema.safeParse(makeEnvelope('chat.done', done)).success).toBe(true);
    expect(
      ChatDoneSchema.safeParse(
        makeEnvelope('chat.done', { ...done, segments: [{ type: 'thinking' }, segment] }),
      ).success,
    ).toBe(true);
    expect(
      ChatDoneSchema.safeParse(
        makeEnvelope('chat.done', { ...done, segments: [{ type: 'tool', name: 'x' }] }),
      ).success,
    ).toBe(false);
  });

  it('rejects a bad tool status and keeps welcome.features optional', () => {
    const bad = { type: 'tool', name: 'Read', status: 'nope' };
    expect(
      ChatActivitySchema.safeParse(
        makeEnvelope('chat.activity', { chatId: 'c', threadId: THREAD, seq: 0, segment: bad }),
      ).success,
    ).toBe(false);
    const welcome = {
      workstationId: THREAD,
      serverTime: new Date().toISOString(),
      limits: { maxConcurrentShifts: 1 },
    };
    expect(WelcomeSchema.safeParse(makeEnvelope('welcome', welcome)).success).toBe(true);
    expect(
      WelcomeSchema.safeParse(makeEnvelope('welcome', { ...welcome, features: ['chat-activity:1'] })).success,
    ).toBe(true);
  });

  it('the browser union carries chat.activity and chat.done with an optional message', () => {
    const a = { type: 'chat.activity', threadId: THREAD, seq: 0, segment: { type: 'thinking' } };
    expect(BrowserChatActivitySchema.safeParse(a).success).toBe(true);
    expect(ServerToBrowserSchema.safeParse(a).success).toBe(true);
    expect(
      ServerToBrowserSchema.safeParse({ type: 'chat.done', threadId: THREAD, messageId: THREAD }).success,
    ).toBe(true);
    const message = {
      id: THREAD,
      threadId: THREAD,
      authorKind: 'agent',
      authorUserId: null,
      authorAgentId: THREAD,
      authorName: 'Ada',
      kind: 'chat',
      body: 'hi',
      data: { segments: [] },
      createdAt: new Date().toISOString(),
    };
    expect(
      ServerToBrowserSchema.safeParse({ type: 'chat.done', threadId: THREAD, messageId: THREAD, message })
        .success,
    ).toBe(true);
  });

  it('caps a long turn to the first 50, an ellipsis and the last 249, and clips long text', () => {
    const many: ChatSegment[] = Array.from({ length: 400 }, (_, i) => ({ type: 'text', text: `t${i}` }));
    const capped = capChatSegments(many);
    expect(capped).toHaveLength(CHAT_SEGMENTS_MAX);
    expect(capped[49]).toEqual({ type: 'text', text: 't49' });
    expect(capped[50]).toEqual({ type: 'text', text: '…' });
    expect(capped[51]).toEqual({ type: 'text', text: 't151' });
    expect(capped.at(-1)).toEqual({ type: 'text', text: 't399' });
    const [clipped] = capChatSegments([{ type: 'text', text: 'x'.repeat(70_000) }]);
    expect(clipped?.type === 'text' && clipped.text.length).toBe(64_000);
  });

  it('caps the total text of a turn, keeping the head and the tail', () => {
    const big: ChatSegment[] = Array.from({ length: 60 }, (_, i) => ({
      type: 'text',
      text: `${i}:`.padEnd(60_000, 'x'),
    }));
    const capped = capChatSegments(big);
    const total = capped.reduce((n, s) => n + (s.type === 'text' ? s.text.length : 0), 0);
    expect(total).toBeLessThanOrEqual(CHAT_TURN_TEXT_MAX + 1);
    expect(capped.some((s) => s.type === 'text' && s.text === '…')).toBe(true);
    expect(capped[0]).toEqual(big[0]);
    expect(capped.at(-1)).toEqual(big.at(-1));
    // a turn under the cap is untouched
    expect(capChatSegments(big.slice(0, 5))).toEqual(big.slice(0, 5));
  });

  it('joins the text segments with a blank line', () => {
    expect(
      chatSegmentsText([
        { type: 'text', text: 'one' },
        { type: 'tool', name: 'Read', status: 'ok' },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'two' },
      ]),
    ).toBe('one\n\ntwo');
  });
});
