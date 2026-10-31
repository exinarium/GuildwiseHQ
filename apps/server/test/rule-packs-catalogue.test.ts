import { RULE_PACKS, SERVER_CHECKS, type ServerCheckId } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { contradicts, isNearDuplicate } from '../src/commands/ledger-checks.ts';

// GWP-31 (no database): the shipped catalogue checks itself, and every 'server check' has a proof.

describe('rule pack catalogue against the ledger checks', () => {
  it('has no rules inside one pack that are near-duplicates or contradict, so an install never flags itself', () => {
    for (const p of RULE_PACKS) {
      for (let i = 0; i < p.rules.length; i++)
        for (let j = i + 1; j < p.rules.length; j++) {
          const a = p.rules[i];
          const b = p.rules[j];
          if (!a || !b) continue;
          expect(isNearDuplicate(a, b), `${p.id}: ${a.id} ~ ${b.id}`).toBe(false);
          expect(contradicts(a, b), `${p.id}: ${a.id} x ${b.id}`).toBe(false);
        }
    }
  });
});

/** One proof per server check: a check without a proof is a type error. */
const PROOFS = {} satisfies Record<ServerCheckId, () => Promise<void>>;

describe('server-check rules', () => {
  it('every rule badged as a server check has a proof that the server refuses the violation', () => {
    for (const p of RULE_PACKS)
      for (const r of p.rules)
        if (r.enforcedBy === 'server_check') expect(Object.keys(PROOFS)).toContain(r.serverCheck);
  });

  it('every declared server check has a proof', () => {
    expect(Object.keys(PROOFS).sort()).toEqual(Object.keys(SERVER_CHECKS).sort());
  });
});
