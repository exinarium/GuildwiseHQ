import { describe, expect, it } from 'vitest';
import {
  CeoRpcSchema,
  countRepeats,
  DEFAULT_CEO_POLICY,
  evaluatePolicy,
  isKnownChoice,
  MODEL_CHOICES,
  modelChoicesFor,
  normalizeJobKind,
  resolveModelChoice,
  suggestForRepeat,
  summarizeCommandTexts,
} from '../src/index.ts';

const DAY = 86_400_000;
const NOW = new Date('2026-10-19T12:00:00Z');
const daysAgo = (...d: number[]) => d.map((x) => new Date(NOW.getTime() - x * DAY));

describe('model choices (docs section 5.4)', () => {
  it('resolves message, then thread, then default', () => {
    const def = { runtime: 'claude-code', model: 'sonnet', effort: 'medium' };
    const opus = { runtime: 'claude-code', model: 'opus', effort: 'high' };
    const haiku = { runtime: 'claude-code', model: 'haiku' };
    expect(resolveModelChoice({ default: def })).toEqual({ choice: def, source: 'default' });
    expect(resolveModelChoice({ thread: opus, default: def })).toEqual({ choice: opus, source: 'thread' });
    expect(resolveModelChoice({ message: haiku, thread: opus, default: def })).toEqual({
      choice: haiku,
      source: 'message',
    });
    expect(resolveModelChoice({ message: null, thread: null, default: def }).source).toBe('default');
  });

  it('knows the registry, filters by runtime, and checks efforts', () => {
    expect(isKnownChoice({ runtime: 'claude-code', model: 'opus', effort: 'high' })).toBe(true);
    expect(isKnownChoice({ runtime: 'claude-code', model: 'haiku' })).toBe(true);
    expect(isKnownChoice({ runtime: 'claude-code', model: 'haiku', effort: 'high' })).toBe(false);
    expect(isKnownChoice({ runtime: 'claude-code', model: 'gpt-9' })).toBe(false);
    expect(isKnownChoice({ runtime: 'other', model: 'opus' })).toBe(false);
    expect(modelChoicesFor(['claude-code']).map((m) => m.runtime)).toEqual(['claude-code']);
    expect(modelChoicesFor().map((m) => m.runtime)).toEqual(Object.keys(MODEL_CHOICES));
  });
});

describe('repeat detection (docs section 14.5)', () => {
  it('4 in 7 days, or 10 in 30 days; fewer is not a repeat', () => {
    expect(countRepeats(daysAgo(1, 2, 3), NOW).hit).toBe(false);
    expect(countRepeats(daysAgo(1, 2, 3, 6.9), NOW)).toMatchObject({ hit: true, count7: 4, count30: 4 });
    // four jobs, but spread over two weeks
    expect(countRepeats(daysAgo(1, 2, 9, 12), NOW)).toMatchObject({ hit: false, count7: 2 });
    // ten in thirty days, never four in a week
    const spread = daysAgo(1, 4, 8, 11, 14, 17, 20, 23, 26, 29);
    expect(countRepeats(spread, NOW)).toMatchObject({ hit: true, count7: 2, count30: 10 });
    expect(countRepeats(daysAgo(1, 4, 8, 11, 14, 17, 20, 23, 26, 31), NOW).hit).toBe(false);
  });

  it('suggests a feature for a project job, an automation for the same command, a skill otherwise', () => {
    expect(suggestForRepeat({ hasProject: true, firstTokens: ['pg_dump', 'pg_dump'] })).toBe('feature');
    expect(suggestForRepeat({ hasProject: false, firstTokens: ['pg_dump', 'pg_dump', 'pg_dump'] })).toBe(
      'automation',
    );
    expect(suggestForRepeat({ hasProject: false, firstTokens: ['pg_dump', 'ls'] })).toBe('skill');
    expect(suggestForRepeat({ hasProject: false, firstTokens: [''] })).toBe('skill');
    expect(normalizeJobKind('  Direct Edit!! ')).toBe('direct-edit');
    expect(normalizeJobKind('###')).toBe('unlabelled');
  });
});

describe('policy by provenance (docs section 6.2)', () => {
  const base = { confidence: 0.95 };

  it('a wake keeps recommending; an owner turn turns the same verdict into an inline confirmation', () => {
    const wake = evaluatePolicy(DEFAULT_CEO_POLICY, 'card.cancel', { ...base, origin: { kind: 'wake' } });
    expect(wake).toMatchObject({ verdict: 'recommend', cause: 'mode' });
    expect(wake.inline).toBeUndefined();
    const owner = evaluatePolicy(DEFAULT_CEO_POLICY, 'card.cancel', { ...base, origin: { kind: 'owner' } });
    expect(owner).toMatchObject({ verdict: 'recommend', cause: 'mode', inline: true });
    // reserved and low confidence too
    expect(
      evaluatePolicy(DEFAULT_CEO_POLICY, 'devops.request', {
        ...base,
        origin: { kind: 'owner' },
        reservedKey: 'devops_destructive',
      }).inline,
    ).toBe(true);
    expect(
      evaluatePolicy(DEFAULT_CEO_POLICY, 'card.reprioritise', { confidence: 0.2, origin: { kind: 'owner' } })
        .inline,
    ).toBe(true);
    // a limit or missing evidence is not for the owner to approve inline
    expect(
      evaluatePolicy(DEFAULT_CEO_POLICY, 'card.reprioritise', {
        ...base,
        origin: { kind: 'owner' },
        limitReached: 'x',
      }).inline,
    ).toBeUndefined();
    // hard-never and `never` stay never in an owner turn
    expect(
      evaluatePolicy(DEFAULT_CEO_POLICY, 'billing', { ...base, origin: { kind: 'owner' } }).verdict,
    ).toBe('deny');
  });

  it('an order turn may act on reserved keys only where its authorization covers them', () => {
    const order = (covers: string[]) => ({
      ...base,
      reservedKey: 'devops_destructive' as const,
      origin: { kind: 'order' as const, covers },
    });
    expect(evaluatePolicy(DEFAULT_CEO_POLICY, 'devops.request', order(['devops_destructive'])).verdict).toBe(
      'allow',
    );
    expect(evaluatePolicy(DEFAULT_CEO_POLICY, 'devops.request', order([])).verdict).toBe('recommend');
    expect(evaluatePolicy(DEFAULT_CEO_POLICY, 'devops.request', order(['manual_qa'])).verdict).toBe(
      'recommend',
    );
    expect(evaluatePolicy(DEFAULT_CEO_POLICY, 'billing', order(['devops_destructive'])).verdict).toBe('deny');
  });

  it('an untrusted wake recommends invoking an order; outside text never decides', () => {
    expect(evaluatePolicy(DEFAULT_CEO_POLICY, 'order.invoke', { ...base, untrustedOrigin: true }).cause).toBe(
      'untrusted',
    );
    expect(evaluatePolicy(DEFAULT_CEO_POLICY, 'order.invoke', { ...base }).verdict).toBe('allow');
    expect(evaluatePolicy(DEFAULT_CEO_POLICY, 'deploy.run', { ...base, untrustedOrigin: true }).cause).toBe(
      'untrusted',
    );
  });
});

describe('the new rpc operations', () => {
  it('parse and reject like the others', () => {
    expect(CeoRpcSchema.safeParse({ op: 'correction', text: 'you did X', rule: 'do Y' }).success).toBe(true);
    expect(CeoRpcSchema.safeParse({ op: 'correction', text: 'x', rule: 'y' }).success).toBe(false);
    expect(
      CeoRpcSchema.safeParse({ op: 'job', sub: 'log', kind: 'x', title: 'y', command: 'pg_dump -x' }).success,
    ).toBe(true);
    expect(CeoRpcSchema.safeParse({ op: 'job', sub: 'nope' }).success).toBe(false);
    expect(
      CeoRpcSchema.safeParse({
        op: 'order',
        sub: 'invoke',
        entryId: '2c0c7a8a-0000-4000-8000-000000000000',
        confidence: 2,
      }).success,
    ).toBe(false);
    expect(CeoRpcSchema.safeParse({ op: 'permission', sub: 'ask', tool: 'Bash', input: 'ls' }).success).toBe(
      true,
    );
    expect(CeoRpcSchema.safeParse({ op: 'devops_status', requestId: 'nope' }).success).toBe(false);
  });
});

describe('summarizeCommandTexts (pre-production review S4)', () => {
  it('keeps first words and counts only: no arguments, paths, queries or assigned values', () => {
    const out = summarizeCommandTexts([
      'aom graph find PaymentGateway --in /srv/acme/src/ledger.ts',
      'aom ceo route ledger/payments',
      'API_TOKEN=abc123 /usr/local/bin/deploy.sh --force',
      'git status',
      '"quoted" arg',
      '$(weird)',
      'git*2',
    ]);
    expect(out).toEqual(['aom*2', 'deploy.sh*1', 'git*3', 'quoted*1', 'other*1']);
    expect(out.join(' ')).not.toMatch(/PaymentGateway|ledger|abc123|srv|payments/);
  });
});
