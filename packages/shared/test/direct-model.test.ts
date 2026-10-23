import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BOARD_PURPOSE_VERBS,
  COMMON_TOOLS,
  chatToolsFor,
  costUsdMicros,
  DEFAULT_MODEL_PRICES,
  DIRECT_PROVIDER_IDS,
  DIRECT_PROVIDERS,
  DIRECT_RUNTIME,
  DISCOVERY_PURPOSE_VERBS,
  directPrice,
  findModelOption,
  isCostUnknown,
  isKnownChoice,
  MODEL_CHOICES,
  modelChoiceLabel,
  modelChoicesFor,
  type ReportedProvider,
  renderDirectSystemPrompt,
  renderSessionTurnInstructions,
  renderToolMapping,
  resolveModelChoice,
  SESSION_PURPOSE_VERBS,
  SESSION_TOOLS,
  SessionTurnSpecSchema,
  sessionToolsFor,
  splitDirectModel,
} from '../src/index.ts';

const openai: ReportedProvider = {
  id: 'openai',
  label: 'OpenAI',
  models: [
    { id: 'gpt-5-mini', label: 'GPT-5 mini', tier: 'medium' },
    { id: 'gpt-5', label: 'GPT-5', tier: 'large' },
  ],
};
const compat: ReportedProvider = {
  id: 'openai-compatible',
  label: 'OpenAI-compatible endpoint',
  models: [{ id: 'llama3', label: 'llama3' }],
  endpointHost: 'localhost:11434',
};

describe('merged model choices', () => {
  it('keeps the built-ins and adds one group per reported provider', () => {
    const groups = modelChoicesFor(['claude-code', 'direct-model'], [openai, compat]);
    expect(groups.map((g) => [g.runtime, g.provider ?? null])).toEqual([
      ['claude-code', null],
      ['direct-model', 'openai'],
      ['direct-model', 'openai-compatible'],
    ]);
    expect(groups[1]?.models.map((m) => m.id)).toEqual(['openai:gpt-5-mini', 'openai:gpt-5']);
    // a workstation that reports no providers offers no direct models; the registry itself never lists them
    expect(modelChoicesFor(['claude-code']).map((g) => g.runtime)).toEqual(['claude-code']);
    expect(Object.keys(MODEL_CHOICES)).toEqual(['claude-code', 'mock']);
  });

  it('validates a direct choice against what the workstation reports', () => {
    const ok = { runtime: DIRECT_RUNTIME, model: 'openai:gpt-5' };
    expect(isKnownChoice(ok, [openai])).toBe(true);
    expect(isKnownChoice({ runtime: DIRECT_RUNTIME, model: 'openai:gpt-9' }, [openai])).toBe(false);
    expect(isKnownChoice({ runtime: DIRECT_RUNTIME, model: 'google:gemini-2.5-pro' }, [openai])).toBe(false);
    // an OpenAI-compatible endpoint may serve any model id
    expect(isKnownChoice({ runtime: DIRECT_RUNTIME, model: 'openai-compatible:qwen3' }, [compat])).toBe(true);
    // the workstation is not known: only the shape is checked
    expect(isKnownChoice(ok)).toBe(true);
    expect(isKnownChoice({ runtime: DIRECT_RUNTIME, model: 'gpt-5' })).toBe(false);
    expect(isKnownChoice({ ...ok, effort: 'high' }, [openai])).toBe(false);
    expect(isKnownChoice({ runtime: 'claude-code', model: 'opus', effort: 'xhigh' })).toBe(true);
    expect(isKnownChoice({ runtime: 'claude-code', model: 'haiku', effort: 'high' })).toBe(false);
  });

  it('labels a direct choice with its provider and finds its option', () => {
    expect(modelChoiceLabel({ runtime: DIRECT_RUNTIME, model: 'openai:gpt-5-mini' }, [openai])).toBe(
      'OpenAI GPT-5 mini',
    );
    expect(modelChoiceLabel({ runtime: DIRECT_RUNTIME, model: 'google:gemini-2.5-pro' })).toBe(
      'Google Gemini Gemini 2.5 Pro',
    );
    expect(modelChoiceLabel({ runtime: DIRECT_RUNTIME, model: 'openai-compatible:qwen3' })).toBe(
      'OpenAI-compatible endpoint qwen3',
    );
    expect(modelChoiceLabel({ runtime: 'claude-code', model: 'opus', effort: 'high' })).toBe('Opus (high)');
    expect(findModelOption({ runtime: DIRECT_RUNTIME, model: 'openai:gpt-5' }, [openai])?.tier).toBe('large');
  });

  it('falls through an override that is not available on the workstation', () => {
    const def = { runtime: 'claude-code', model: 'sonnet' };
    const thread = { runtime: DIRECT_RUNTIME, model: 'openai:gpt-5' };
    const message = { runtime: DIRECT_RUNTIME, model: 'google:gemini-2.5-pro' };
    const available = (c: { model: string }) => c.model.startsWith('openai:') || c.model === 'sonnet';
    expect(resolveModelChoice({ message, thread, default: def, isAvailable: available })).toEqual({
      choice: thread,
      source: 'thread',
    });
    expect(resolveModelChoice({ message, default: def, isAvailable: available })).toEqual({
      choice: def,
      source: 'default',
    });
    expect(resolveModelChoice({ message, thread, default: def })).toEqual({
      choice: message,
      source: 'message',
    });
  });

  it('splits provider:model ids', () => {
    expect(splitDirectModel('openai:gpt-5')).toEqual({ provider: 'openai', model: 'gpt-5' });
    expect(splitDirectModel('openai-compatible:org/model:latest')).toEqual({
      provider: 'openai-compatible',
      model: 'org/model:latest',
    });
    expect(splitDirectModel('mistral:large')).toBeNull();
    expect(splitDirectModel('haiku')).toBeNull();
  });
});

describe('prices of direct models', () => {
  const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };
  it('prices the listed models from the table, dated snapshots included', () => {
    expect(costUsdMicros('openai:gpt-5-mini', u)).toBe(2_275_000);
    expect(costUsdMicros('openai:gpt-5-mini-2025-08-07', u)).toBe(2_275_000);
    expect(costUsdMicros('openai:gpt-5', u)).toBe(11_375_000);
    expect(costUsdMicros('google:gemini-2.5-flash', u)).toBe(2_875_000);
    // gpt-5 must not be priced as gpt-5-mini or the other way round
    expect(directPrice('openai', 'gpt-5-nano')?.input).toBe(0.05);
    expect(directPrice('openai', 'gpt-5-mini')?.input).toBe(0.25);
  });
  it('prices the Anthropic API like Claude Code, from the one Claude table', () => {
    for (const m of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
      expect(costUsdMicros(`anthropic:${m}`, u)).toBe(costUsdMicros(m, u));
    expect(isCostUnknown('anthropic:claude-sonnet-5-5')).toBe(false);
  });
  it('never prices an unknown model at the Sonnet fallback, and says it is unknown', () => {
    for (const m of [
      'openai:gpt-99',
      'google:gemini-9',
      'anthropic:claude-mystery',
      'openai-compatible:llama3',
    ]) {
      expect(isCostUnknown(m)).toBe(true);
      expect(costUsdMicros(m, u)).toBe(0);
    }
    // the Claude Code and mock models keep their old behaviour
    expect(isCostUnknown('sonnet')).toBe(false);
    expect(isCostUnknown('mock')).toBe(false);
    expect(costUsdMicros('mock', u)).toBeGreaterThan(0);
    expect(DEFAULT_MODEL_PRICES.at(-1)?.match).toBe('');
  });
  it('lists every provider once, with prices only on models that have a list price', () => {
    expect(DIRECT_PROVIDERS.map((p) => p.id)).toEqual([...DIRECT_PROVIDER_IDS]);
    for (const p of DIRECT_PROVIDERS.filter((x) => x.id === 'openai' || x.id === 'google'))
      for (const m of p.models) expect(m.price?.input, `${p.id}:${m.id}`).toBeGreaterThan(0);
    expect(DIRECT_PROVIDERS.find((p) => p.id === 'openai-compatible')?.needsBaseUrl).toBe(true);
    for (const p of DIRECT_PROVIDERS) expect(p.dataNote).toMatch(/Guildwise|endpoint/);
  });
});

describe('the tools of a session turn', () => {
  const names = (purpose: string | undefined) =>
    sessionToolsFor(purpose)
      .map((t) => t.name)
      .sort();

  it('offers exactly the verbs the purpose table allows, plus the common tools', () => {
    for (const [purpose, verbs] of Object.entries(SESSION_PURPOSE_VERBS)) {
      const board = purpose.startsWith('board_');
      const expected = SESSION_TOOLS.filter(
        (t) => t.family === (board ? 'board' : 'session') && t.verb && verbs.includes(t.verb),
      )
        .map((t) => t.name)
        .concat(COMMON_TOOLS.map((t) => t.name))
        .sort();
      expect(names(purpose), purpose).toEqual(expected);
    }
    expect(names('board_speaker')).not.toContain('board_next');
    expect(names('board_speaker')).not.toContain('session_show');
    expect(names('facilitator')).not.toContain('board_show');
    expect(names(undefined)).toEqual(['ledger_search', 'skill_list', 'skill_show']);
    expect(names('no-such-purpose')).toEqual(['ledger_search', 'skill_list', 'skill_show']);
    expect(
      chatToolsFor()
        .map((t) => t.name)
        .sort(),
    ).toEqual(['ledger_search', 'skill_list', 'skill_show']);
  });

  it('keeps the discovery and board permission tables apart', () => {
    expect(Object.keys(DISCOVERY_PURPOSE_VERBS).sort()).toEqual(['ceo_answer', 'facilitator']);
    expect(Object.keys(BOARD_PURPOSE_VERBS).sort()).toEqual([
      'board_cast',
      'board_chair',
      'board_minutes',
      'board_speaker',
    ]);
  });

  it('has a tool for every verb the table allows, with a unique name and a schema every provider accepts', () => {
    const all = new Set(SESSION_TOOLS.map((t) => t.name));
    expect(all.size).toBe(SESSION_TOOLS.length);
    for (const [purpose, verbs] of Object.entries(SESSION_PURPOSE_VERBS))
      for (const v of verbs)
        expect(
          SESSION_TOOLS.some(
            (t) => t.verb === v && t.family === (purpose.startsWith('board_') ? 'board' : 'session'),
          ),
          `${purpose}:${v}`,
        ).toBe(true);
    for (const t of [...SESSION_TOOLS, ...COMMON_TOOLS]) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      const js = z.toJSONSchema(t.input, { io: 'input' }) as { type?: string };
      expect(js.type, t.name).toBe('object');
    }
  });

  it('accepts the same input the aom CLI would send, and fills the defaults the server expects', () => {
    const ask = SESSION_TOOLS.find((t) => t.name === 'session_ask');
    expect(ask?.input.parse({ question: 'Who is it for?' })).toEqual({
      question: 'Who is it for?',
      options: [],
      allowFreeText: true,
    });
    const add = SESSION_TOOLS.find((t) => t.name === 'board_add');
    expect(add?.input.safeParse({ column: 'nonsense', text: 'x' }).success).toBe(false);
    expect(SESSION_TOOLS.find((t) => t.name === 'session_note_update')?.fixed).toEqual({ op: 'update' });
  });
});

describe('the direct runtime’s instructions', () => {
  const spec = SessionTurnSpecSchema.parse({
    turnId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
    kind: 'boardroom',
    purpose: 'board_speaker',
    speaker: { kind: 'persona', name: 'Cost Hawk', seat: 'Panel', stance: 'Frugal', voice: 'Plain' },
    roster: [{ name: 'Pieter', kind: 'user', seat: 'Owner' }],
  });

  it('writes the same room sections as for Claude Code and tells the model to call tools instead of a shell', () => {
    const tools = sessionToolsFor('board_speaker');
    const direct = renderDirectSystemPrompt({
      session: { spec, persona: 'You watch the money.' },
      tools,
      capabilityIndex: '# Capabilities\n- skill:x',
    });
    const cli = renderSessionTurnInstructions(spec, 'You watch the money.');
    for (const part of [
      'You are Cost Hawk, seated as Panel',
      'Your stance: Frugal',
      'Your voice: Plain',
      'You watch the money.',
      '- Pieter (Owner, user)',
    ])
      expect(direct).toContain(part);
    expect(direct).toContain('# Capabilities');
    expect(direct).toContain('`aom board add ...` -> tool `board_add`');
    expect(direct).not.toContain('board_next');
    expect(direct).not.toContain('The only command you may run is');
    expect(direct).toContain('You have no shell');
    expect(cli).toContain('The only command you may run is');
    expect(renderToolMapping(tools).split('\n')).toHaveLength(tools.length);
  });

  it('renders a plain chat honestly about what it cannot do', () => {
    const md = renderDirectSystemPrompt({
      chat: {
        agent: { name: 'Cleo', roleKey: 'ceo', seniority: 'senior' },
        context: { orgId: 'o', projectKey: 'TOY' } as never,
      },
      tools: chatToolsFor(),
    });
    expect(md).toContain('You are Cleo, a senior ceo');
    expect(md).toContain('without a shell or files');
    expect(md).toContain('`ledger_search`');
    expect(md).toContain('project TOY');
  });
});
