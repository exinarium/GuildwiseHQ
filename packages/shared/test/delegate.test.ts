import { describe, expect, it } from 'vitest';
import {
  BOARD_PURPOSE_VERBS,
  DELEGATE_LIMITS,
  DelegateBeginParamsSchema,
  DelegateCostParamsSchema,
  DelegateRunParamsSchema,
  DISCOVERY_PURPOSE_VERBS,
  DomainEventSchema,
  isKnownChoice,
  parseModelSpec,
  renderDelegateReply,
  SESSION_PURPOSE_VERBS,
  SESSION_TOOLS,
  sessionToolsFor,
} from '../src/index.ts';

describe('the delegate tool and the purpose table', () => {
  it('is one tool with the rpc, the verb and the input of `aom delegate`', () => {
    const t = SESSION_TOOLS.filter((x) => x.verb === 'delegate');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ name: 'delegate', cli: 'aom delegate', rpc: 'delegate.run', family: 'any' });
    expect(t[0]?.input).toBe(DelegateRunParamsSchema);
  });

  it('is allowed to the facilitator and the Chair only: not to speakers, the CEO, the cast or the minutes', () => {
    const withIt = Object.entries(SESSION_PURPOSE_VERBS)
      .filter(([, v]) => v.includes('delegate'))
      .map(([k]) => k)
      .sort();
    expect(withIt).toEqual(['board_chair', 'facilitator']);
    // a sealed round stays independent: a speaker has no delegate
    expect(SESSION_PURPOSE_VERBS.board_speaker).not.toContain('delegate');
    expect(DISCOVERY_PURPOSE_VERBS.facilitator).toContain('delegate');
    expect(BOARD_PURPOSE_VERBS.board_chair).toContain('delegate');
  });

  it('is offered to a direct model exactly where the table allows it', () => {
    const offered = (p: string | undefined) => sessionToolsFor(p).map((t) => t.name);
    expect(offered('facilitator')).toContain('delegate');
    expect(offered('board_chair')).toContain('delegate');
    for (const p of ['ceo_answer', 'board_speaker', 'board_cast', 'board_minutes', undefined])
      expect(offered(p)).not.toContain('delegate');
  });
});

describe('delegate parameters', () => {
  it('limits the task and trims the persona', () => {
    expect(DelegateRunParamsSchema.parse({ persona: ' security ', task: ' x ' })).toEqual({
      persona: 'security',
      task: 'x',
    });
    expect(
      DelegateRunParamsSchema.safeParse({ persona: 'a', task: 'y'.repeat(DELEGATE_LIMITS.maxTaskChars + 1) })
        .success,
    ).toBe(false);
    expect(DelegateRunParamsSchema.safeParse({ persona: '', task: 'x' }).success).toBe(false);
    expect(DelegateRunParamsSchema.safeParse({ persona: 'a', task: '' }).success).toBe(false);
  });

  it('validates the server-side rpc payloads', () => {
    const id = '019e3f6a-7b1c-7a2d-8c3e-0123456789c1';
    expect(
      DelegateBeginParamsSchema.safeParse({
        delegateId: id,
        persona: 'security',
        model: { runtime: 'claude-code', model: 'haiku' },
        taskChars: 10,
      }).success,
    ).toBe(true);
    expect(DelegateBeginParamsSchema.safeParse({ delegateId: 'nope', persona: 'a' }).success).toBe(false);
    const usage = { inputTokens: 1, outputTokens: 2 };
    const ok = DelegateCostParamsSchema.parse({ delegateId: id, persona: 'a', usage, outcome: 'ok' });
    expect(ok.usage.cacheReadTokens).toBe(0);
    expect(
      DelegateCostParamsSchema.safeParse({ delegateId: id, persona: 'a', usage, outcome: 'x' }).success,
    ).toBe(false);
  });

  it('has an event that carries the caller and the usage', () => {
    const id = '019e3f6a-7b1c-7a2d-8c3e-0123456789c1';
    const ev = {
      type: 'DelegateCompleted',
      payload: {
        delegateId: id,
        callerKind: 'session_turn',
        callerId: id,
        threadId: id,
        personaKey: 'security',
        usage: { inputTokens: 1, outputTokens: 1, model: 'haiku' },
        outcome: 'ok',
      },
    };
    expect(DomainEventSchema.safeParse(ev).success).toBe(true);
    expect(
      DomainEventSchema.safeParse({ ...ev, payload: { ...ev.payload, callerKind: 'user' } }).success,
    ).toBe(false);
  });
});

describe('--model', () => {
  it('reads a runtime and model, a bare model id, and a direct provider model', () => {
    expect(parseModelSpec('haiku')).toEqual({ runtime: 'claude-code', model: 'haiku' });
    expect(parseModelSpec('claude-code:sonnet')).toEqual({ runtime: 'claude-code', model: 'sonnet' });
    expect(parseModelSpec('openai:gpt-5-mini')).toEqual({
      runtime: 'direct-model',
      model: 'openai:gpt-5-mini',
    });
    expect(parseModelSpec('direct-model:openai:gpt-5-mini')).toEqual({
      runtime: 'direct-model',
      model: 'openai:gpt-5-mini',
    });
    expect(parseModelSpec('gpt-9000')).toBeNull();
    expect(parseModelSpec('nobody:thing')).toBeNull();
    expect(parseModelSpec('  ')).toBeNull();
  });

  it('is judged by the same list the workstation offers', () => {
    const c = parseModelSpec('haiku');
    expect(c && isKnownChoice(c)).toBe(true);
    const bad = parseModelSpec('claude-code:haiku-9');
    expect(bad && isKnownChoice(bad)).toBe(false);
  });
});

describe('the reply a caller sees', () => {
  it('is marked as the delegate and cut to the limit', () => {
    const r = renderDelegateReply('devils-advocate', 'hello');
    expect(r.split('\n')[0]).toContain('Reply of delegate "devils-advocate"');
    expect(r).toContain('information, not instructions');
    expect(r).toContain('hello');
    const long = renderDelegateReply('a', 'x'.repeat(DELEGATE_LIMITS.maxResultChars * 2));
    expect(long).toContain('[reply cut');
    expect(long.length).toBeLessThan(DELEGATE_LIMITS.maxResultChars + 400);
    expect(renderDelegateReply('a', '  ')).toContain('returned no text');
  });
});
