import {
  backendDef,
  DIRECT_RUNTIME,
  type ModelChoice,
  modelChoicesFor,
  type ReportedBackend,
  type ReportedModel,
  type ReportedProvider,
  type RuntimeExtras,
  splitBackendModel,
} from '@aom/shared';
import { Select } from './ui.tsx';

/** Role pickers for the three models; empty means "the default for the workstation" (cheap for personas and the Chair, strong for the minutes). */
export function ModelSelect({
  label,
  hint,
  value,
  onChange,
  runtimes,
  providers,
  extras,
  defaultLabel = 'Default',
  ariaLabel,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  runtimes: string[];
  providers: ReportedProvider[];
  /** The Claude Code backends and the data-driven model lists the workstations report (`unionExtras`). */
  extras?: RuntimeExtras;
  defaultLabel?: string;
  ariaLabel?: string;
}) {
  const groups = modelChoicesFor(runtimes.length ? runtimes : undefined, providers, extras);
  const direct = value.startsWith(`${DIRECT_RUNTIME}/`);
  // a model behind a gateway may follow Claude Code's tools and instructions less reliably: said where it is picked
  const picked = value.startsWith('claude-code/')
    ? splitBackendModel(value.slice('claude-code/'.length))
    : null;
  const caution = picked ? backendDef(picked.backend)?.warning : undefined;
  return (
    <Select
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      hint={
        caution ??
        (direct ? 'Direct API model: no shell or file tools, which a boardroom does not need.' : hint)
      }
      aria-label={ariaLabel}
    >
      <option value="">{defaultLabel}</option>
      {groups.flatMap((g) =>
        g.models.map((m) => (
          <option key={`${g.runtime}/${m.id}`} value={`${g.runtime}/${m.id}`}>
            {g.label}: {m.label}
          </option>
        )),
      )}
    </Select>
  );
}

/** `runtime/model`: the model id of a direct model carries its provider and may contain `/` itself. */
export const toChoice = (v: string): ModelChoice | undefined => {
  if (!v) return undefined;
  const i = v.indexOf('/');
  const runtime = i < 0 ? '' : v.slice(0, i);
  const model = i < 0 ? '' : v.slice(i + 1);
  return runtime && model ? { runtime, model } : undefined;
};
export const fromChoice = (c: ModelChoice | undefined): string => (c ? `${c.runtime}/${c.model}` : '');

/** The direct providers the workstations report, merged by provider (models of the same provider are united). */
export function unionProviders(
  list: ReadonlyArray<{ runtimes?: Array<{ id: string; providers?: ReportedProvider[] }> }>,
) {
  const by = new Map<string, ReportedProvider>();
  for (const w of list)
    for (const r of w.runtimes ?? [])
      if (r.id === DIRECT_RUNTIME)
        for (const p of r.providers ?? []) {
          const cur = by.get(p.id);
          if (!cur) by.set(p.id, { ...p, models: [...p.models] });
          else for (const m of p.models) if (!cur.models.some((x) => x.id === m.id)) cur.models.push(m);
        }
  return [...by.values()];
}

/**
 * What the workstations report beyond the direct providers: the Claude Code backends with a credential (models united by
 * backend) and the data-driven model lists of the Gemini CLI and opencode (united by runtime).
 */
export function unionExtras(
  list: ReadonlyArray<{
    runtimes?: Array<{ id: string; backends?: ReportedBackend[]; models?: ReportedModel[] }>;
  }>,
): RuntimeExtras {
  const backends = new Map<string, ReportedBackend>();
  const models: Record<string, ReportedModel[]> = {};
  for (const w of list)
    for (const r of w.runtimes ?? []) {
      for (const b of r.backends ?? []) {
        const cur = backends.get(b.id);
        if (!cur) backends.set(b.id, { ...b, models: [...b.models] });
        else for (const m of b.models) if (!cur.models.some((x) => x.id === m.id)) cur.models.push(m);
      }
      if (r.models?.length) {
        const cur = models[r.id] ?? [];
        models[r.id] = cur;
        for (const m of r.models) if (!cur.some((x) => x.id === m.id)) cur.push(m);
      }
    }
  return {
    ...(backends.size ? { backends: [...backends.values()] } : {}),
    ...(Object.keys(models).length ? { models } : {}),
  };
}
