import { describe, expect, it } from 'vitest';
import {
  CODEX_MODEL_PREFIX,
  CODEX_RUNTIME,
  codexPrice,
  codexRoleProblem,
  codexUsageModel,
  costUsdMicros,
  DEFAULT_MODEL_PRICES,
  findModelOption,
  isCodexModel,
  isCostUnknown,
  isKnownChoice,
  MODEL_CHOICES,
  modelChoiceLabel,
  modelChoicesFor,
} from '../src/index.ts';

describe('codex model choices', () => {
  it('lists the models of `codex debug models` (0.163.0) by size, with the efforts they understand', () => {
    const models = MODEL_CHOICES[CODEX_RUNTIME] ?? [];
    expect(models.map((m) => [m.id, m.tier])).toEqual([
      ['gpt-6-luna', 'small'],
      ['gpt-6.1-sol', 'medium'],
      ['gpt-6-astra', 'large'],
    ]);
    for (const m of models) expect(m.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('is a group only for a workstation that reports the runtime', () => {
    expect(modelChoicesFor(['claude-code']).map((g) => g.runtime)).toEqual(['claude-code']);
    const g = modelChoicesFor(['claude-code', 'codex']).find((x) => x.runtime === 'codex');
    expect(g?.label).toBe('Codex');
    expect(modelChoicesFor().map((x) => x.runtime)).toContain('codex'); // the registry as a whole
  });

  it('validates a choice against the registry, effort included', () => {
    expect(isKnownChoice({ runtime: 'codex', model: 'gpt-6.1-sol' })).toBe(true);
    expect(isKnownChoice({ runtime: 'codex', model: 'gpt-6-astra', effort: 'max' })).toBe(true);
    expect(isKnownChoice({ runtime: 'codex', model: 'gpt-6-luna', effort: 'ultra' })).toBe(false);
    expect(isKnownChoice({ runtime: 'codex', model: 'opus' })).toBe(false);
    expect(isKnownChoice({ runtime: 'claude-code', model: 'gpt-6.1-sol' })).toBe(false);
    expect(findModelOption({ runtime: 'codex', model: 'gpt-6-luna' })?.label).toBe('GPT-6 Luna');
    expect(modelChoiceLabel({ runtime: 'codex', model: 'gpt-6-astra', effort: 'high' })).toBe(
      'GPT-6 Astra (high)',
    );
  });
});

describe('codex cost', () => {
  it('knows its models and prices none of them like a Claude model', () => {
    expect(codexUsageModel('gpt-6-sol')).toBe(`${CODEX_MODEL_PREFIX}gpt-6-sol`);
    expect(codexUsageModel('codex:gpt-6-sol')).toBe('codex:gpt-6-sol');
    for (const m of ['codex:gpt-6-sol', 'gpt-6.1-sol', 'o3', 'codex-mini-latest'])
      expect(isCodexModel(m)).toBe(true);
    for (const m of ['sonnet', 'claude-opus-5-5', 'openai:gpt-5', 'mock'])
      expect(isCodexModel(m)).toBe(false);
    expect(codexPrice('codex:gpt-6-sol')).toBeNull();
  });

  it('flags a Codex turn as cost unknown (0), and leaves Claude models priced', () => {
    const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };
    for (const m of ['codex:gpt-6-sol', 'gpt-6-astra']) {
      expect(isCostUnknown(m)).toBe(true);
      expect(costUsdMicros(m, tokens)).toBe(0);
    }
    expect(isCostUnknown('claude-sonnet-5-5')).toBe(false);
    expect(costUsdMicros('claude-sonnet-5-5', tokens)).toBeGreaterThan(0);
    // the fallback entry is still Sonnet's: the point is that a Codex model never reaches it
    expect(DEFAULT_MODEL_PRICES.at(-1)?.match).toBe('');
  });
});

describe('which roles may run on codex', () => {
  const p = (over = {}) => ({
    allowedTools: ['read', 'edit', 'shell'],
    writableGlobs: null,
    browser: false,
    ...over,
  });
  it('allows a builder, a reviewer and a BA task (a shell, no browser, no path-limited writes)', () => {
    expect(codexRoleProblem({ roleKey: 'builder', permissions: p() })).toBeNull();
    expect(
      codexRoleProblem({ roleKey: 'reviewer', permissions: p({ allowedTools: ['read', 'shell'] }) }),
    ).toBeNull();
    expect(
      codexRoleProblem({ roleKey: 'ba', permissions: p({ allowedTools: ['read', 'shell', 'web'] }) }),
    ).toBeNull();
  });
  it('refuses DevOps, the CEO, shell-less, browser and path-limited roles', () => {
    expect(codexRoleProblem({ roleKey: 'devops', permissions: p() })).toMatch(/guard/);
    expect(codexRoleProblem({ roleKey: 'ceo', permissions: p() })).toMatch(/guard/);
    expect(codexRoleProblem({ roleKey: 'custom', isDevops: true, permissions: p() })).not.toBeNull();
    expect(codexRoleProblem({ roleKey: 'analyst', permissions: p({ allowedTools: ['read'] }) })).toMatch(
      /no shell/,
    );
    expect(codexRoleProblem({ roleKey: 'tester', permissions: p({ browser: true }) })).toMatch(/browsers/);
    expect(codexRoleProblem({ roleKey: 'writer', permissions: p({ writableGlobs: ['docs/**'] }) })).toMatch(
      /certain paths/,
    );
    // a read-only role with a glob list writes nothing, so the list does not matter
    expect(
      codexRoleProblem({
        roleKey: 'x',
        permissions: p({ allowedTools: ['read', 'shell'], writableGlobs: [] }),
      }),
    ).toBeNull();
  });
});
