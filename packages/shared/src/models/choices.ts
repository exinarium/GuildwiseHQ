import { z } from 'zod';
import { backendDef, splitBackendModel } from './backends.ts';
import type { ReportedBackend, ReportedModel } from './credentials.ts';
import {
  DIRECT_RUNTIME,
  directModelId,
  directProvider,
  type ModelTier,
  type ReportedProvider,
  splitDirectModel,
} from './direct.ts';
import { GEMINI_RUNTIME, OPENCODE_RUNTIME } from './runtimes.ts';

/**
 * Provider-neutral model choices (docs/design/ceo-front-door.md section 5.4). A choice is `{runtime, model, effort}`.
 * The registry lists what the product offers per runtime; the web filters it by the runtimes a workstation reports.
 */
export const ModelChoiceSchema = z.object({
  runtime: z.string().min(1).max(60),
  model: z.string().min(1).max(120),
  effort: z.string().min(1).max(20).optional(),
});
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;

export interface ModelOption {
  id: string;
  label: string;
  /** Effort levels the model understands, lowest first (empty: the model has no effort setting). */
  effortLevels: readonly string[];
  /** Rough size, used to pick defaults for a role (personas cheap, the synthesis strong) on any runtime. */
  tier?: ModelTier;
}

export const MODEL_CHOICES: Readonly<Record<string, readonly ModelOption[]>> = {
  'claude-code': [
    { id: 'haiku', label: 'Haiku', effortLevels: [], tier: 'small' },
    { id: 'sonnet', label: 'Sonnet', effortLevels: ['low', 'medium', 'high'], tier: 'medium' },
    { id: 'opus', label: 'Opus', effortLevels: ['low', 'medium', 'high', 'xhigh'], tier: 'large' },
  ],
  // The Codex CLI runtime (registered by a runner only when the `codex` binary is found). Ids are the model slugs of
  // `codex debug models` (codex-cli 0.163.0); `ultra` effort (automatic task delegation) is left out.
  codex: [
    {
      id: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      tier: 'small',
    },
    {
      id: 'gpt-6.1-sol',
      label: 'GPT-6.1 Sol',
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      tier: 'medium',
    },
    {
      id: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      tier: 'large',
    },
  ],
  // The Gemini CLI runtime (registered by a runner only when the `gemini` binary is found). The ids are the models the CLI
  // accepts (`VALID_GEMINI_MODELS` of @google/gemini-cli 0.65). The CLI has no reasoning-effort option, so none is offered.
  // A workstation can add ids (`runtimes.gemini.models`) and reports them.
  gemini: [
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', effortLevels: [], tier: 'large' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', effortLevels: [], tier: 'large' },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', effortLevels: [], tier: 'medium' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', effortLevels: [], tier: 'medium' },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', effortLevels: [], tier: 'small' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', effortLevels: [], tier: 'small' },
  ],
  mock: [{ id: 'mock', label: 'Mock', effortLevels: [], tier: 'medium' }],
};
// The opencode runtime has no entry here either: its models are what the workstation's opencode reports for the providers that
// have a key there (`provider/model`), see `RuntimeExtras`.
// The direct-model runtime has no entry here: its models come from what each workstation's runner reports (the providers
// whose key is stored there), see `ReportedProvider` and `modelChoicesFor`.

/** Display names of the runtimes (the model menu groups by runtime). */
export const RUNTIME_LABEL: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  [GEMINI_RUNTIME]: 'Gemini CLI',
  [OPENCODE_RUNTIME]: 'opencode',
  mock: 'Mock',
  [DIRECT_RUNTIME]: 'Direct API',
};

export interface ModelChoiceGroup {
  runtime: string;
  label: string;
  models: readonly ModelOption[];
  /** Direct-model groups: the provider (one group per provider). Claude Code backend groups: the backend. */
  provider?: string;
  /** A caution to show beside the group (models behind a gateway). */
  warning?: string;
}

/**
 * What a workstation reports beyond the direct-model providers: the Claude Code backends that have a credential there, and the
 * models of the runtimes whose list comes from the workstation (gemini: the built-ins plus its extras; opencode: all of them).
 */
export interface RuntimeExtras {
  backends?: readonly ReportedBackend[];
  models?: Readonly<Record<string, readonly ReportedModel[]>>;
}

/** The pickers' option for a model a provider reports: the model id carries the provider (`openai:gpt-5`). */
function reportedOption(p: ReportedProvider, m: ReportedProvider['models'][number]): ModelOption {
  return {
    id: directModelId(p.id, m.id),
    label: m.label,
    effortLevels: [],
    ...(m.tier ? { tier: m.tier } : {}),
  };
}

/** Claude Code through a backend: the model id carries the backend (`bedrock:us.anthropic...`); efforts are Claude's own. */
function backendOption(b: ReportedBackend, m: ReportedModel): ModelOption {
  return {
    id: `${b.id}:${m.id}`,
    label: m.label,
    effortLevels: [],
    ...(m.tier ? { tier: m.tier } : {}),
  };
}

const plainOption = (m: ReportedModel): ModelOption => ({
  id: m.id,
  label: m.label,
  effortLevels: [],
  ...(m.tier ? { tier: m.tier } : {}),
});

/**
 * The options of the runtimes in `runtimes` (absent: all of the registry), plus one group per direct-model provider the
 * workstation's runner reports (`providers`), one per Claude Code backend it has a credential for, and the data-driven lists of
 * gemini and opencode (`extras`). This is what a workstation really offers: the built-ins merged with what its runner reports.
 */
export function modelChoicesFor(
  runtimes?: readonly string[],
  providers?: readonly ReportedProvider[],
  extras?: RuntimeExtras,
): ModelChoiceGroup[] {
  const groups: ModelChoiceGroup[] = [];
  for (const [runtime, builtin] of Object.entries(MODEL_CHOICES)) {
    if (runtimes && !runtimes.includes(runtime)) continue;
    let models: readonly ModelOption[] = builtin;
    const reported = extras?.models?.[runtime];
    if (reported?.length) {
      const known = new Set(builtin.map((m) => m.id));
      models = [...builtin, ...reported.filter((m) => !known.has(m.id)).map(plainOption)];
    }
    groups.push({ runtime, label: RUNTIME_LABEL[runtime] ?? runtime, models });
    if (runtime === 'claude-code')
      for (const b of extras?.backends ?? []) {
        const def = backendDef(b.id);
        if (!b.models.length) continue;
        groups.push({
          runtime,
          provider: b.id,
          label: `${b.label} (Claude Code)`,
          models: b.models.map((m) => backendOption(b, m)),
          ...(def?.warning ? { warning: def.warning } : {}),
        });
      }
  }
  const opencode = extras?.models?.[OPENCODE_RUNTIME];
  if (opencode?.length && (!runtimes || runtimes.includes(OPENCODE_RUNTIME)))
    groups.push({
      runtime: OPENCODE_RUNTIME,
      label: RUNTIME_LABEL[OPENCODE_RUNTIME] ?? OPENCODE_RUNTIME,
      models: opencode.map(plainOption),
    });
  for (const p of providers ?? [])
    if (p.models.length)
      groups.push({
        runtime: DIRECT_RUNTIME,
        provider: p.id,
        label: `${p.label} (direct)`,
        models: p.models.map((m) => reportedOption(p, m)),
      });
  return groups;
}

/** Looks a choice up in the registry or in the reported providers. */
export function findModelOption(
  c: Pick<ModelChoice, 'runtime' | 'model'>,
  providers?: readonly ReportedProvider[],
  extras?: RuntimeExtras,
): ModelOption | undefined {
  if (c.runtime === 'claude-code') {
    const q = splitBackendModel(c.model);
    if (q) {
      const b = extras?.backends?.find((x) => x.id === q.backend);
      const m =
        b?.models.find((x) => x.id === q.model) ??
        backendDef(q.backend)?.models.find((x) => x.id === q.model);
      if (m) return { id: c.model, label: m.label, effortLevels: [], tier: m.tier };
      return { id: c.model, label: q.model, effortLevels: [] };
    }
  }
  if (c.runtime === OPENCODE_RUNTIME) {
    const m = extras?.models?.[OPENCODE_RUNTIME]?.find((x) => x.id === c.model);
    return m ? plainOption(m) : undefined;
  }
  if (c.runtime !== DIRECT_RUNTIME) {
    const built = MODEL_CHOICES[c.runtime]?.find((m) => m.id === c.model);
    if (built) return built;
    const r = extras?.models?.[c.runtime]?.find((m) => m.id === c.model);
    return r ? plainOption(r) : undefined;
  }
  const d = splitDirectModel(c.model);
  if (!d) return undefined;
  const reported = providers?.find((p) => p.id === d.provider);
  const m = reported?.models.find((x) => x.id === d.model);
  if (reported && m) return reportedOption(reported, m);
  const built = directProvider(d.provider)?.models.find((x) => x.id === d.model);
  return built ? { id: c.model, label: built.label, effortLevels: [], tier: built.tier } : undefined;
}

/**
 * The choice names a model of the registry (and an effort that model understands, when one is given), or a direct-model
 * `provider:model`. With `providers` (what the target workstation reports) a direct model must be one of theirs, or any id
 * of an OpenAI-compatible endpoint that is configured there (such an endpoint serves models the runner cannot list). Without
 * `providers` the workstation is not known and any well-formed direct model passes.
 */
export function isKnownChoice(
  c: ModelChoice,
  providers?: readonly ReportedProvider[],
  extras?: RuntimeExtras,
): boolean {
  // Claude Code through a backend: `bedrock:<id>`. Any well-formed id passes (Bedrock inference profiles, Vertex versions and
  // gateway models are the owner's to name); with the workstation's report the backend must have a credential there. The
  // efforts are Claude's own.
  if (c.runtime === 'claude-code') {
    const q = splitBackendModel(c.model);
    if (q) {
      if (c.effort && !MODEL_CHOICES['claude-code']?.some((m) => m.effortLevels.includes(c.effort ?? '')))
        return false;
      return !extras?.backends || extras.backends.some((b) => b.id === q.backend);
    }
  }
  // opencode: `provider/model` from the workstation's list when it is known; any well-formed id otherwise.
  if (c.runtime === OPENCODE_RUNTIME) {
    if (c.effort || !/^[^/\s]+\/\S+$/.test(c.model)) return false;
    const list = extras?.models?.[OPENCODE_RUNTIME];
    return !list || list.some((m) => m.id === c.model);
  }
  if (c.runtime === GEMINI_RUNTIME && !MODEL_CHOICES[GEMINI_RUNTIME]?.some((m) => m.id === c.model)) {
    // an extra id the owner added on that workstation
    return !c.effort && !!extras?.models?.[GEMINI_RUNTIME]?.some((m) => m.id === c.model);
  }
  if (c.runtime === DIRECT_RUNTIME) {
    const d = splitDirectModel(c.model);
    if (!d || c.effort) return false;
    if (!providers) return true;
    const p = providers.find((x) => x.id === d.provider);
    if (!p) return false;
    return d.provider === 'openai-compatible' || p.models.some((m) => m.id === d.model);
  }
  const opt = MODEL_CHOICES[c.runtime]?.find((m) => m.id === c.model);
  if (!opt) return false;
  return !c.effort || opt.effortLevels.includes(c.effort);
}

export type ModelChoiceSource = 'message' | 'thread' | 'default';

/** Message override, else thread override, else the default (`ceo.settings.models.chat`). */
export function resolveModelChoice(input: {
  message?: ModelChoice | null | undefined;
  thread?: ModelChoice | null | undefined;
  default: ModelChoice;
  /**
   * Is this choice usable on the target workstation (its runtime is there, and for a direct model its provider is configured
   * and offers the model)? An override that is not falls through to the next level, so a thread override set while a
   * provider key was stored never strands the thread after the key is removed.
   */
  isAvailable?: (c: ModelChoice) => boolean;
}): { choice: ModelChoice; source: ModelChoiceSource } {
  const ok = (c: ModelChoice | null | undefined): c is ModelChoice => !!c && (input.isAvailable?.(c) ?? true);
  if (ok(input.message)) return { choice: input.message, source: 'message' };
  if (ok(input.thread)) return { choice: input.thread, source: 'thread' };
  return { choice: input.default, source: 'default' };
}

export const modelChoiceLabel = (
  c: ModelChoice,
  providers?: readonly ReportedProvider[],
  extras?: RuntimeExtras,
): string => {
  const opt = findModelOption(c, providers, extras);
  if (c.runtime === DIRECT_RUNTIME) {
    const d = splitDirectModel(c.model);
    const provider = d ? (directProvider(d.provider)?.label ?? d.provider) : '';
    return `${provider ? `${provider} ` : ''}${opt?.label ?? d?.model ?? c.model}`;
  }
  return `${opt?.label ?? c.model}${c.effort ? ` (${c.effort})` : ''}`;
};

export const sameChoice = (a: ModelChoice, b: ModelChoice): boolean =>
  a.runtime === b.runtime && a.model === b.model && (a.effort ?? '') === (b.effort ?? '');
