import { z } from 'zod';
import {
  DIRECT_RUNTIME,
  directModelId,
  directProvider,
  type ModelTier,
  type ReportedProvider,
  splitDirectModel,
} from './direct.ts';

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
  mock: [{ id: 'mock', label: 'Mock', effortLevels: [], tier: 'medium' }],
};
// The direct-model runtime has no entry here: its models come from what each workstation's runner reports (the providers
// whose key is stored there), see `ReportedProvider` and `modelChoicesFor`.

/** Display names of the runtimes (the model menu groups by runtime). */
export const RUNTIME_LABEL: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  mock: 'Mock',
  [DIRECT_RUNTIME]: 'Direct API',
};

export interface ModelChoiceGroup {
  runtime: string;
  label: string;
  models: readonly ModelOption[];
  /** Direct-model groups: the provider (one group per provider). */
  provider?: string;
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

/**
 * The options of the runtimes in `runtimes` (absent: all of the registry), plus one group per direct-model provider the
 * workstation's runner reports (`providers`). This is what a workstation really offers: the built-ins merged with what its
 * runner reports.
 */
export function modelChoicesFor(
  runtimes?: readonly string[],
  providers?: readonly ReportedProvider[],
): ModelChoiceGroup[] {
  const groups: ModelChoiceGroup[] = Object.entries(MODEL_CHOICES)
    .filter(([runtime]) => !runtimes || runtimes.includes(runtime))
    .map(([runtime, models]) => ({ runtime, label: RUNTIME_LABEL[runtime] ?? runtime, models }));
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
): ModelOption | undefined {
  if (c.runtime !== DIRECT_RUNTIME) return MODEL_CHOICES[c.runtime]?.find((m) => m.id === c.model);
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
export function isKnownChoice(c: ModelChoice, providers?: readonly ReportedProvider[]): boolean {
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

export const modelChoiceLabel = (c: ModelChoice, providers?: readonly ReportedProvider[]): string => {
  const opt = findModelOption(c, providers);
  if (c.runtime === DIRECT_RUNTIME) {
    const d = splitDirectModel(c.model);
    const provider = d ? (directProvider(d.provider)?.label ?? d.provider) : '';
    return `${provider ? `${provider} ` : ''}${opt?.label ?? d?.model ?? c.model}`;
  }
  return `${opt?.label ?? c.model}${c.effort ? ` (${c.effort})` : ''}`;
};

export const sameChoice = (a: ModelChoice, b: ModelChoice): boolean =>
  a.runtime === b.runtime && a.model === b.model && (a.effort ?? '') === (b.effort ?? '');
