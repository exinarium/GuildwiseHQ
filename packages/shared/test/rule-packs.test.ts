import { describe, expect, it } from 'vitest';
import {
  ENFORCED_BY_LABEL,
  enforcedByFor,
  RULE_PACKS,
  rulePackById,
  SERVER_CHECKS,
} from '../src/ledger/rule-packs.ts';

describe('rule pack catalogue', () => {
  it('ships exactly the expected packs (adding or dropping one is a visible change)', () => {
    expect(RULE_PACKS.map((p) => p.id)).toEqual(['core', 'outbound', 'real-estate', 'accounting', 'law']);
  });

  it('has unique pack ids, unique rule ids per pack, kebab-case ids and kind/industry that agree', () => {
    const ids = RULE_PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of RULE_PACKS) {
      expect(p.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(p.version).toBeGreaterThan(0);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.rules.length).toBeGreaterThan(0);
      expect(!!p.industry).toBe(p.kind === 'industry');
      const rids = p.rules.map((r) => r.id);
      expect(new Set(rids).size).toBe(rids.length);
    }
  });

  it('gives every rule text within the event limits, an enforced-by value and a source', () => {
    for (const p of RULE_PACKS)
      for (const r of p.rules) {
        expect(r.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(r.title.length).toBeGreaterThanOrEqual(1);
        expect(r.title.length).toBeLessThanOrEqual(300);
        expect(r.body.length).toBeGreaterThanOrEqual(1);
        expect(r.body.length).toBeLessThanOrEqual(20000);
        expect(r.scope).toBe('standing_order');
        expect(['server_check', 'agent_instruction']).toContain(r.enforcedBy);
        expect(r.source.length).toBeGreaterThan(0);
      }
  });

  it('claims server enforcement only for a rule that names a known server check', () => {
    for (const p of RULE_PACKS)
      for (const r of p.rules) {
        if (r.enforcedBy === 'server_check') {
          expect(r.serverCheck, `${p.id}/${r.id}`).toBeDefined();
          expect(Object.keys(SERVER_CHECKS)).toContain(r.serverCheck);
        } else expect(r.serverCheck).toBeUndefined();
      }
  });

  it('labels both values', () => {
    expect(ENFORCED_BY_LABEL.server_check).toBe('Guildwise (server check)');
    expect(ENFORCED_BY_LABEL.agent_instruction).toBe('Agent instruction');
  });

  it('enforcedByFor gives the pack value only for an unedited pack rule', () => {
    const p = RULE_PACKS[0];
    const r = p?.rules[0];
    if (!p || !r) throw new Error('catalogue empty');
    expect(rulePackById(p.id)).toBe(p);
    expect(enforcedByFor({ rulePackId: p.id, rulePackRuleId: r.id, version: 1 })).toBe(r.enforcedBy);
    // edited, hand-written, or no longer in the catalogue: an instruction to agents
    expect(enforcedByFor({ rulePackId: p.id, rulePackRuleId: r.id, version: 2 })).toBe('agent_instruction');
    expect(enforcedByFor({ rulePackId: null, rulePackRuleId: null, version: 1 })).toBe('agent_instruction');
    expect(enforcedByFor({ rulePackId: 'gone', rulePackRuleId: 'x', version: 1 })).toBe('agent_instruction');
  });
});
