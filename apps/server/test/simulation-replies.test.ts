import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scriptedReply } from '../../runner/src/adapters/mock.ts';
import { SIMULATION_REPLIES } from '../src/simulation/replies.ts';

const file = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'aom-replies-')), 'replies.json');
writeFileSync(file, JSON.stringify(SIMULATION_REPLIES));
const reply = (m: string) => scriptedReply(m, 'Grace', file) as string;
const all = (key: string) => {
  const v = SIMULATION_REPLIES[key];
  return Array.isArray(v) ? v : [v as string];
};

describe('scripted simulation replies', () => {
  it('every pattern compiles and every topic has alternatives', () => {
    for (const [k, v] of Object.entries(SIMULATION_REPLIES)) {
      const m = /^\/(.+)\/([a-z]*)$/.exec(k);
      if (m) expect(() => new RegExp(m[1] as string, m[2])).not.toThrow();
      expect(Array.isArray(v) ? v.length : 1).toBeGreaterThan(0);
    }
    // varied: the common topics have several alternatives
    expect(
      Object.values(SIMULATION_REPLIES).filter((v) => Array.isArray(v) && v.length >= 3).length,
    ).toBeGreaterThan(8);
  });

  it.each([
    [
      'Can you write acceptance criteria for the login page?',
      /acceptance criteria|success path|testable|checks?/i,
    ],
    ['What are the requirements for checkout?', /requirement/i],
    ['Is this in scope for the first release?', /scope|release/i],
    ['What should we build next?', /next|backlog|board/i],
    ['Turn this conversation into cards', /card/i],
    ['How long will this take? I need an estimate', /day|hour|range/i],
    ['What is the status of the project?', /project|cards|progress|flow|healthy/i],
    ['What are the main risks?', /risk|watch|mitigat/i],
    ['What are you working on?', /card|queue|review/i],
    ['Did the tests pass?', /test|green|check/i],
    ['What is the deploy status?', /deploy|pipeline|release|environment/i],
  ])('answers "%s" on topic', (q, re) => {
    expect(reply(q)).toMatch(re);
  });

  it('falls back to a default for anything else, names the agent, and never claims real work', () => {
    const r = reply('Purple monkey dishwasher');
    expect(typeof r).toBe('string');
    expect(all('*')).toContain(
      r.replaceAll('Grace', '{name}').replaceAll('Purple monkey dishwasher', '{message}'),
    );
    for (const a of all('*'))
      expect(a).not.toMatch(/\bI (have )?(deployed|pushed|wrote the code|shipped)\b/i);
  });

  it('is stable for the same words and varies across different ones', () => {
    expect(reply('How is it going?')).toBe(reply('How is it going?'));
    const outs = new Set(
      [
        'status?',
        'any update',
        'where are we',
        'how is it going',
        'progress report',
        'give me a summary',
      ].map(reply),
    );
    expect(outs.size).toBeGreaterThan(1);
  });
});
