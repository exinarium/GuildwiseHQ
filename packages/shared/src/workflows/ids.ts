import { slugify } from '../ids.ts';
import type { WorkflowDefinitionInput } from './schema.ts';

/**
 * Id derivation for the workflow builder (docs/design/workflow-builder.md 2.2): stage ids, outcome ids and field keys
 * are slugs of the owner's labels, matching the schema pattern `^[a-z][a-z0-9_]*$`. Once a workflow has an approved
 * version its ids are frozen: renaming a label keeps the id, because cards and roles reference ids.
 */

/** `Check the copy` -> `check_the_copy`; a label that yields nothing (or starts with a digit) gets a safe prefix. */
export function idFromLabel(label: string, fallback = 'step', max = 40): string {
  const base = slugify(label, max).replace(/-/g, '_');
  const id = base === '' ? fallback : base;
  return /^[a-z]/.test(id) ? id : `${fallback}_${id}`;
}

/** `base`, or `base_2`, `base_3`, ... the first one not in `taken`. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface IdItem {
  /** Existing id, if the item was already saved. */
  id?: string;
  label: string;
}

/**
 * Assigns ids to a list of labelled items, keeping order. An item keeps its `id` when that id is in `frozen`
 * (the ids of an approved version: never changed, even when the label changed), or, by default (`keepExisting`),
 * whenever it already has one (renaming a label does not change ids). With `keepExisting: false` only frozen ids are
 * kept and every other item is re-derived from its label (a never-approved draft). Items without an id get a unique
 * slug of their label.
 */
export function assignIds<T extends IdItem>(
  items: readonly T[],
  opts: { frozen?: ReadonlySet<string>; keepExisting?: boolean; fallback?: string } = {},
): (T & { id: string })[] {
  const frozen = opts.frozen ?? new Set<string>();
  const keepExisting = opts.keepExisting ?? true;
  const taken = new Set<string>();
  const keeps = (i: T) => i.id !== undefined && i.id !== '' && (frozen.has(i.id) || keepExisting);
  for (const i of items) if (keeps(i)) taken.add(i.id as string);
  return items.map((i) => {
    if (keeps(i)) return { ...i, id: i.id as string };
    const id = uniqueId(idFromLabel(i.label, opts.fallback), taken);
    taken.add(id);
    return { ...i, id };
  });
}

/** Ids of the approved version of a workflow that the builder may no longer change: stages, outcomes per stage, fields. */
export interface FrozenIds {
  stages: ReadonlySet<string>;
  /** stage id -> outcome ids. */
  outcomes: ReadonlyMap<string, ReadonlySet<string>>;
  fields: ReadonlySet<string>;
}

export function frozenIdsOf(
  approved: Pick<WorkflowDefinitionInput, 'stages' | 'customFields'> | null | undefined,
): FrozenIds {
  const outcomes = new Map<string, ReadonlySet<string>>();
  for (const s of approved?.stages ?? []) outcomes.set(s.id, new Set((s.outcomes ?? []).map((o) => o.id)));
  return {
    stages: new Set((approved?.stages ?? []).map((s) => s.id)),
    outcomes,
    fields: new Set((approved?.customFields ?? []).map((f) => f.key)),
  };
}

/** Does a draft keep every id the approved version froze? Returns the ids that disappeared (stages as `stage`, outcomes as `stage.outcome`). */
export function missingFrozenIds(
  frozen: FrozenIds,
  draft: Pick<WorkflowDefinitionInput, 'stages'>,
): string[] {
  const missing: string[] = [];
  for (const id of frozen.stages) {
    const s = draft.stages.find((x) => x.id === id);
    if (!s) {
      missing.push(id);
      continue;
    }
    for (const oid of frozen.outcomes.get(id) ?? []) {
      if (!(s.outcomes ?? []).some((o) => o.id === oid)) missing.push(`${id}.${oid}`);
    }
  }
  return missing;
}
