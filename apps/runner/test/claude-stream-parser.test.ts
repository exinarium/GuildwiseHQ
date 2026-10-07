import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeStreamParser } from '../src/adapters/claude-stream-parser.ts';
import type { RuntimeEvent } from '../src/adapters/types.ts';

function parse(name: string): { events: RuntimeEvent[]; parser: ClaudeStreamParser } {
  const parser = new ClaudeStreamParser();
  const lines = readFileSync(join(import.meta.dirname, 'fixtures', 'claude-stream', name), 'utf8').split(
    '\n',
  );
  return { events: lines.flatMap((l) => parser.parseLine(l)), parser };
}

describe('claude stream parser', () => {
  it('maps a successful session: session, progress, tools, usage totals, final', () => {
    const { events, parser } = parse('success.jsonl');
    expect(events[0]).toEqual({ kind: 'session', runtimeSessionId: '7c1f6f0e-5d2a-4a56-9f9a-3b1d0c7e1a11' });
    expect(events.filter((e) => e.kind === 'progress').map((e) => (e as { text: string }).text)).toEqual([
      "I'll start by reading the card and the existing code.",
      'Done. Handed off with aom handoff.',
    ]);
    expect(events.filter((e) => e.kind === 'tool')).toEqual([
      { kind: 'tool', name: 'Bash', summary: 'aom card --json' },
      { kind: 'tool', name: 'Write', summary: '/work/toy/src/greeting.ts' },
    ]);
    expect(events.at(-2)).toEqual({
      kind: 'usage',
      usage: {
        inputTokens: 1520,
        outputTokens: 910,
        cacheReadTokens: 42000,
        cacheWriteTokens: 8000,
        model: 'claude-sonnet-4-5',
        costUsd: expect.any(Number),
      },
    });
    expect(events.at(-1)).toEqual({ kind: 'final', text: 'Done. Handed off with aom handoff.' });
    expect(parser.usage()).toMatchObject({
      inputTokens: 1520,
      outputTokens: 910,
      cacheReadTokens: 42000,
      cacheWriteTokens: 8000,
      model: 'claude-sonnet-4-5',
    });
    expect(parser.resultError).toBeUndefined();
  });

  it('flags an error result (is_error) and still reports usage and the message', () => {
    const { events, parser } = parse('error.jsonl');
    expect(parser.resultError).toBe('success');
    expect(events.find((e) => e.kind === 'final')).toEqual({
      kind: 'final',
      text: 'Invalid API key - Please run /login',
    });
    expect(parser.usage().inputTokens).toBe(0);
  });

  it('summarises several tool uses in one message and truncates long inputs to 200 chars', () => {
    const { events } = parse('tool-use.jsonl');
    const tools = events.filter((e): e is Extract<RuntimeEvent, { kind: 'tool' }> => e.kind === 'tool');
    expect(tools.map((t) => t.name)).toEqual(['Bash', 'Read', 'Grep', 'Bash']);
    expect(tools[0]?.summary).toBe('pnpm test --silent');
    expect(tools[1]?.summary).toBe('/work/toy/README.md');
    expect(tools[2]?.summary).toBe('{"pattern":"greet","path":"/work/toy"}');
    expect(tools[3]?.summary).toHaveLength(200);
  });

  it('error_max_turns: usage is kept, no final text, error recorded', () => {
    const { events, parser } = parse('max-turns.jsonl');
    expect(parser.resultError).toBe('error_max_turns');
    expect(events.some((e) => e.kind === 'final')).toBe(false);
    expect(parser.usage()).toMatchObject({
      inputTokens: 900,
      outputTokens: 400,
      cacheReadTokens: 2000,
      cacheWriteTokens: 100,
      costUsd: 0.5,
    });
  });

  it('a session that never reaches the result line still reports what its messages used', () => {
    const p = new ClaudeStreamParser();
    const line = (o: unknown) => p.parseLine(JSON.stringify(o));
    line({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-4-5' });
    line({
      type: 'assistant',
      message: {
        id: 'm1',
        model: 'claude-opus-4-5',
        content: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    // The same message id repeated (streamed partials) counts once, with its latest numbers.
    line({
      type: 'assistant',
      message: {
        id: 'm1',
        model: 'claude-opus-4-5',
        content: [],
        usage: {
          input_tokens: 10,
          output_tokens: 50,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 20,
        },
      },
    });
    line({
      type: 'assistant',
      message: { id: 'm2', content: [], usage: { input_tokens: 4, output_tokens: 6 } },
    });
    expect(p.usage()).toEqual({
      inputTokens: 14,
      outputTokens: 56,
      cacheReadTokens: 1000,
      cacheWriteTokens: 20,
      model: 'claude-opus-4-5',
    });
  });

  it('takes the model and the cost from the result: the model with the most tokens wins', () => {
    const p = new ClaudeStreamParser();
    p.parseLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'ok',
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.0123,
        modelUsage: {
          'claude-haiku-4-5': { inputTokens: 10, outputTokens: 5 },
          'claude-sonnet-4-5': { inputTokens: 90, outputTokens: 45 },
        },
      }),
    );
    expect(p.usage()).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: 'claude-sonnet-4-5',
      costUsd: 0.0123,
    });
  });

  it('ignores blank, non-JSON and unknown lines', () => {
    const p = new ClaudeStreamParser();
    expect(p.parseLine('')).toEqual([]);
    expect(p.parseLine('warning: something')).toEqual([]);
    expect(p.parseLine('{"type":"mystery"}')).toEqual([]);
    expect(p.parseLine('{broken')).toEqual([]);
  });
});
