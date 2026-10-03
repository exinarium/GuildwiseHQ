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
      usage: { inputTokens: 1520, outputTokens: 910, cacheReadTokens: 42000, cacheWriteTokens: 8000 },
    });
    expect(events.at(-1)).toEqual({ kind: 'final', text: 'Done. Handed off with aom handoff.' });
    expect(parser.usage()).toEqual({
      inputTokens: 1520,
      outputTokens: 910,
      cacheReadTokens: 42000,
      cacheWriteTokens: 8000,
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
    expect(parser.usage()).toEqual({
      inputTokens: 900,
      outputTokens: 400,
      cacheReadTokens: 2000,
      cacheWriteTokens: 100,
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
