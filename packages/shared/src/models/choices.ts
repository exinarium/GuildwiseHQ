import { z } from 'zod';

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
}

export const MODEL_CHOICES: Readonly<Record<string, readonly ModelOption[]>> = {
  'claude-code': [
    { id: 'haiku', label: 'Haiku', effortLevels: [] },
    { id: 'sonnet', label: 'Sonnet', effortLevels: ['low', 'medium', 'high'] },
    { id: 'opus', label: 'Opus', effortLevels: ['low', 'medium', 'high', 'xhigh'] },
  ],
  mock: [{ id: 'mock', label: 'Mock', effortLevels: [] }],
};

/** Display names of the runtimes (the model menu groups by runtime). */
export const RUNTIME_LABEL: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  mock: 'Mock',
};

/** The options of the runtimes in `runtimes` (absent: all of the registry). */
export function modelChoicesFor(
  runtimes?: readonly string[],
): Array<{ runtime: string; label: string; models: readonly ModelOption[] }> {
  return Object.entries(MODEL_CHOICES)
    .filter(([runtime]) => !runtimes || runtimes.includes(runtime))
    .map(([runtime, models]) => ({ runtime, label: RUNTIME_LABEL[runtime] ?? runtime, models }));
}

/** The choice names a model of the registry (and an effort that model understands, when one is given). */
export function isKnownChoice(c: ModelChoice): boolean {
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
}): { choice: ModelChoice; source: ModelChoiceSource } {
  if (input.message) return { choice: input.message, source: 'message' };
  if (input.thread) return { choice: input.thread, source: 'thread' };
  return { choice: input.default, source: 'default' };
}

export const modelChoiceLabel = (c: ModelChoice): string => {
  const opt = MODEL_CHOICES[c.runtime]?.find((m) => m.id === c.model);
  return `${opt?.label ?? c.model}${c.effort ? ` (${c.effort})` : ''}`;
};

export const sameChoice = (a: ModelChoice, b: ModelChoice): boolean =>
  a.runtime === b.runtime && a.model === b.model && (a.effort ?? '') === (b.effort ?? '');
