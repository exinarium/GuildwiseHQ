import {
  BUILTIN_WORKFLOWS,
  type CustomField,
  type DefinitionIssue,
  type ExplainedIssue,
  explainIssues,
  type FrozenIds,
  frozenIdsOf,
  idFromLabel,
  missingFrozenIds,
  type OrgCatalogueResponse,
  type RoleDefinition,
  type SubworkflowConfigInput,
  uniqueId,
  type ValidationIssue,
  validateCustomWorkflow,
  type WorkflowDefinitionInput,
  WorkflowDefinitionSchema,
} from '@aom/shared';

/**
 * The workflow builder's model (docs/design/workflow-builder.md 2.2): a view over a custom `WorkflowDefinitionInput`
 * that the step-list editor works on. Steps and fields have an internal `uid` that routes and field references use, so
 * a label can change without breaking anything; the real ids are derived from labels in `toDefinition`, and an id that
 * is `fixed` (loaded from a stored definition, or frozen by an approved version) never changes. Pure; no React.
 */

type StageIn = WorkflowDefinitionInput['stages'][number];
type OutcomeIn = NonNullable<StageIn['outcomes']>[number];
type StepKindValue = 'agent' | 'manual' | 'terminal' | 'subworkflow';

/** What the builder stores for a draft: the definition without the server-assigned `version` and `builtIn`. */
export type BuilderDef = Omit<WorkflowDefinitionInput, 'version' | 'builtIn'>;

export interface BuilderRoute {
  id: string;
  label: string;
  kind: 'success' | 'failure';
  /** The uid of the target step (or a raw id the builder does not know). */
  to: string;
  event: OutcomeIn['event'];
  data: NonNullable<OutcomeIn['data']>;
  rework: boolean;
  effect: NonNullable<OutcomeIn['effect']>;
  /** `field` is a field uid (or a raw key the builder does not know). */
  when?: { field: string; equals: unknown };
}

export interface BuilderStep {
  uid: string;
  /** Set: the stage id is fixed and never re-derived from the label. */
  id?: string;
  label: string;
  /** Board column; null follows the label. */
  column: string | null;
  kind: StepKindValue;
  role: string | null;
  seniorOnly: boolean;
  doneCriteria: string;
  /** Field uids (or raw keys of card fields the builder does not list). */
  requiredFields: string[];
  when?: { field: string; equals: unknown };
  worktree: 'create' | 'reuse' | 'none';
  maxShiftMinutes: number;
  subworkflow?: SubworkflowConfigInput;
  routes: BuilderRoute[];
  /** Stage settings the builder does not edit; kept as they are. */
  extra: {
    rebaseBefore: boolean;
    syncMainBefore: boolean;
    approvals?: { small: number; large: number };
    requiredCapabilities: string[];
  };
}

export interface BuilderField {
  uid: string;
  /** Set: the key is fixed. */
  key?: string;
  label: string;
  type: CustomField['type'];
  required: boolean;
}

export interface BuilderModel {
  key: string;
  /** False: the key follows the name (a workflow that was never saved). */
  keyFixed: boolean;
  name: string;
  department?: string;
  cardTypes: string[];
  fieldSet: string;
  extends?: { key: string; version: number };
  fields: BuilderField[];
  steps: BuilderStep[];
  /** uid of the first step. */
  initial: string;
}

const DEFAULT_MAX_SHIFT = 60;

// ---------------------------------------------------------------------------------------------- conversion

const successPriority = (o: BuilderRoute) => (o.kind === 'success' ? (o.when ? 1 : 0) : 2);

/** Index of the "when finished, go to" route: the first success route without a guard, else the first success route. */
export function nextIndex(step: Pick<BuilderStep, 'routes'>): number {
  let best = -1;
  step.routes.forEach((r, i) => {
    if (r.kind !== 'success') return;
    if (best === -1 || successPriority(r) < successPriority(step.routes[best] as BuilderRoute)) best = i;
  });
  return best;
}

/** Index of the "if it is not good enough, send back to" route: the first rework route, else the first failure route. */
export function sendBackIndex(step: Pick<BuilderStep, 'routes'>): number {
  const rework = step.routes.findIndex((r) => r.kind === 'failure' && r.rework);
  return rework !== -1 ? rework : step.routes.findIndex((r) => r.kind === 'failure');
}

/** Routes beyond the two the guided form shows. */
export function otherRoutes(step: BuilderStep): Array<{ route: BuilderRoute; index: number }> {
  const skip = new Set([nextIndex(step), sendBackIndex(step)]);
  return step.routes.map((route, index) => ({ route, index })).filter(({ index }) => !skip.has(index));
}

export function fromDefinition(
  def: BuilderDef | WorkflowDefinitionInput,
  opts: { /** Keep the stored ids and keys for good (default). */ freeze?: boolean } = {},
): BuilderModel {
  const freeze = opts.freeze ?? true;
  const customFields = def.customFields ?? [];
  const fields: BuilderField[] = [];
  const fieldUids = new Map<string, string>();
  const takenFieldUids = new Set<string>();
  for (const f of customFields) {
    const uid = uniqueId(f.key || 'field', takenFieldUids);
    takenFieldUids.add(uid);
    if (!fieldUids.has(f.key)) fieldUids.set(f.key, uid);
    fields.push({
      uid,
      ...(freeze || f.key ? { key: f.key } : {}),
      label: f.label,
      type: f.type,
      required: f.required,
    });
  }
  const fieldRef = (key: string) => fieldUids.get(key) ?? key;

  const takenUids = new Set<string>();
  const uids = def.stages.map((s) => {
    const uid = uniqueId(s.id || 'step', takenUids);
    takenUids.add(uid);
    return uid;
  });
  const uidById = new Map<string, string>();
  def.stages.forEach((s, i) => {
    if (!uidById.has(s.id)) uidById.set(s.id, uids[i] as string);
  });
  const stepRef = (id: string) => uidById.get(id) ?? id;

  const steps: BuilderStep[] = def.stages.map((s, i) => ({
    uid: uids[i] as string,
    ...(freeze ? { id: s.id } : {}),
    label: s.label,
    column: s.column === s.label ? null : s.column,
    kind: s.kind,
    role: s.claimRole ?? null,
    seniorOnly: s.seniorOnly ?? false,
    doneCriteria: s.doneCriteria ?? '',
    requiredFields: (s.requiredFields ?? []).map(fieldRef),
    ...(s.when ? { when: { field: fieldRef(s.when.field), equals: s.when.equals } } : {}),
    worktree: s.worktree ?? 'none',
    maxShiftMinutes: s.maxShiftMinutes ?? DEFAULT_MAX_SHIFT,
    ...(s.subworkflow ? { subworkflow: structuredClone(s.subworkflow) } : {}),
    routes: (s.outcomes ?? []).map((o) => ({
      id: o.id,
      label: o.label,
      kind: o.kind,
      to: stepRef(o.to),
      event: o.event,
      data: o.data ?? 'none',
      rework: o.rework ?? false,
      effect: o.effect ?? 'none',
      ...(o.when ? { when: { field: fieldRef(o.when.field), equals: o.when.equals } } : {}),
    })),
    extra: {
      rebaseBefore: s.rebaseBefore ?? false,
      syncMainBefore: s.syncMainBefore ?? false,
      ...(s.approvals ? { approvals: { ...s.approvals } } : {}),
      requiredCapabilities: [...(s.requiredCapabilities ?? [])],
    },
  }));
  return {
    key: def.key,
    keyFixed: freeze,
    name: def.name,
    ...(def.department ? { department: def.department } : {}),
    cardTypes: [...def.cardTypes],
    fieldSet: def.fieldSet ?? 'custom',
    ...(def.extends ? { extends: { ...def.extends } } : {}),
    fields,
    steps,
    initial: stepRef(def.initialStage),
  };
}

/** The final stage id of every step (fixed ids stay; new steps get a unique slug of their label). */
export function stepIds(model: BuilderModel, frozen?: FrozenIds): Map<string, string> {
  const taken = new Set<string>(frozen?.stages ?? []);
  for (const s of model.steps) if (s.id) taken.add(s.id);
  const out = new Map<string, string>();
  for (const s of model.steps) {
    if (s.id) {
      out.set(s.uid, s.id);
      continue;
    }
    const id = uniqueId(idFromLabel(s.label, 'step'), taken);
    taken.add(id);
    out.set(s.uid, id);
  }
  return out;
}

/** The final key of every custom field. */
export function fieldKeys(model: BuilderModel, frozen?: FrozenIds): Map<string, string> {
  const taken = new Set<string>(frozen?.fields ?? []);
  for (const f of model.fields) if (f.key) taken.add(f.key);
  const out = new Map<string, string>();
  for (const f of model.fields) {
    if (f.key) {
      out.set(f.uid, f.key);
      continue;
    }
    const key = uniqueId(idFromLabel(f.label, 'field'), taken);
    taken.add(key);
    out.set(f.uid, key);
  }
  return out;
}

export function toDefinition(model: BuilderModel, opts: { frozen?: FrozenIds } = {}): BuilderDef {
  const ids = stepIds(model, opts.frozen);
  const keys = fieldKeys(model, opts.frozen);
  const sid = (uid: string) => ids.get(uid) ?? uid;
  const fkey = (uid: string) => keys.get(uid) ?? uid;
  return {
    key: model.key,
    name: model.name,
    ...(model.department ? { department: model.department } : {}),
    fieldSet: model.fieldSet,
    customFields: model.fields.map((f) => ({
      key: fkey(f.uid),
      label: f.label,
      type: f.type,
      required: f.required,
    })),
    cardTypes: [...model.cardTypes],
    initialStage: sid(model.initial),
    stages: model.steps.map((s) => ({
      id: sid(s.uid),
      label: s.label,
      column: s.column ?? s.label,
      kind: s.kind,
      ...(s.subworkflow ? { subworkflow: structuredClone(s.subworkflow) } : {}),
      claimRole: s.role,
      seniorOnly: s.seniorOnly,
      requiredFields: s.requiredFields.map(fkey),
      doneCriteria: s.doneCriteria,
      outcomes: s.routes.map((r) => ({
        id: r.id,
        label: r.label,
        kind: r.kind,
        to: sid(r.to),
        event: r.event,
        data: r.data,
        rework: r.rework,
        effect: r.effect,
        ...(r.when ? { when: { field: fkey(r.when.field), equals: r.when.equals } } : {}),
      })),
      ...(s.when ? { when: { field: fkey(s.when.field), equals: s.when.equals } } : {}),
      worktree: s.worktree,
      rebaseBefore: s.extra.rebaseBefore,
      syncMainBefore: s.extra.syncMainBefore,
      ...(s.extra.approvals ? { approvals: { ...s.extra.approvals } } : {}),
      maxShiftMinutes: s.maxShiftMinutes,
      requiredCapabilities: [...s.extra.requiredCapabilities],
    })),
    ...(model.extends ? { extends: { ...model.extends } } : {}),
  };
}

/** After a save the ids and keys are the server's: nothing is re-derived from a label any more. */
export function freezeModel(model: BuilderModel, frozen?: FrozenIds): BuilderModel {
  const ids = stepIds(model, frozen);
  const keys = fieldKeys(model, frozen);
  return {
    ...model,
    keyFixed: true,
    steps: model.steps.map((s) => ({ ...s, id: s.id ?? (ids.get(s.uid) as string) })),
    fields: model.fields.map((f) => ({ ...f, key: f.key ?? (keys.get(f.uid) as string) })),
  };
}

/** The key follows the name until the workflow is saved; it never collides with an existing workflow. */
export function syncKey(model: BuilderModel, takenKeys: ReadonlySet<string>): BuilderModel {
  if (model.keyFixed) return model;
  const key = uniqueId(idFromLabel(model.name, 'workflow'), takenKeys);
  return key === model.key ? model : { ...model, key };
}

// ------------------------------------------------------------------------------------------------ editing

let counter = 0;
const freshUid = (prefix: string, taken: ReadonlySet<string>): string => {
  for (;;) {
    counter += 1;
    const uid = `new-${prefix}${counter}`;
    if (!taken.has(uid)) return uid;
  }
};

const stepUids = (m: BuilderModel) => new Set(m.steps.map((s) => s.uid));

export function blankStep(
  model: BuilderModel,
  label = 'New step',
  kind: StepKindValue = 'agent',
): BuilderStep {
  return {
    uid: freshUid('s', stepUids(model)),
    label,
    column: null,
    kind,
    role: null,
    seniorOnly: false,
    doneCriteria: '',
    requiredFields: [],
    worktree: 'none',
    maxShiftMinutes: DEFAULT_MAX_SHIFT,
    routes: [],
    extra: { rebaseBefore: false, syncMainBefore: false, requiredCapabilities: [] },
  };
}

const takeId = (step: BuilderStep, base: string): string =>
  uniqueId(base, new Set(step.routes.map((r) => r.id)));

/** A plain "finished" route to `to`. The first (manual) step's route is its "ready to start" route. */
function successRoute(step: BuilderStep, isInitial: boolean, to: string): BuilderRoute {
  const start = isInitial && step.kind === 'manual';
  return {
    id: takeId(step, start ? 'specified' : 'done'),
    label: start ? 'Ready to start' : 'Finished',
    kind: 'success',
    to,
    event: start ? 'CardSpecified' : 'StageCompleted',
    data: 'none',
    rework: false,
    effect: 'none',
  };
}

const sendBackRoute = (step: BuilderStep, to: string): BuilderRoute => ({
  id: takeId(step, 'rework'),
  label: 'Not good enough',
  kind: 'failure',
  to,
  event: 'StageCompleted',
  data: 'none',
  rework: true,
  effect: 'none',
});

const patchStep = (m: BuilderModel, uid: string, f: (s: BuilderStep) => BuilderStep): BuilderModel => ({
  ...m,
  steps: m.steps.map((s) => (s.uid === uid ? f(s) : s)),
});

export function updateStep(m: BuilderModel, uid: string, patch: Partial<BuilderStep>): BuilderModel {
  return patchStep(m, uid, (s) => ({ ...s, ...patch }));
}

/** Sets where the step goes when it is finished (creating the route when it has none). */
export function setNext(m: BuilderModel, uid: string, to: string): BuilderModel {
  return patchStep(m, uid, (s) => {
    const i = nextIndex(s);
    if (i === -1) return { ...s, routes: [...s.routes, successRoute(s, m.initial === s.uid, to)] };
    return { ...s, routes: s.routes.map((r, j) => (j === i ? { ...r, to } : r)) };
  });
}

/** Sets (or, with null, removes) the "send back to" route. */
export function setSendBack(m: BuilderModel, uid: string, to: string | null): BuilderModel {
  return patchStep(m, uid, (s) => {
    const i = sendBackIndex(s);
    if (to === null) return { ...s, routes: s.routes.filter((_, j) => j !== i) };
    if (i === -1) return { ...s, routes: [...s.routes, sendBackRoute(s, to)] };
    return { ...s, routes: s.routes.map((r, j) => (j === i ? { ...r, to } : r)) };
  });
}

export function setRoute(
  m: BuilderModel,
  uid: string,
  index: number,
  patch: Partial<BuilderRoute>,
): BuilderModel {
  return patchStep(m, uid, (s) => ({
    ...s,
    routes: s.routes.map((r, j) => (j === index ? { ...r, ...patch } : r)),
  }));
}

export function removeRoute(m: BuilderModel, uid: string, index: number): BuilderModel {
  return patchStep(m, uid, (s) => ({ ...s, routes: s.routes.filter((_, j) => j !== index) }));
}

/** An extra named route ("If the customer is angry, go to ..."). */
export function addRoute(m: BuilderModel, uid: string, to: string, label = 'Other route'): BuilderModel {
  return patchStep(m, uid, (s) => ({
    ...s,
    routes: [
      ...s.routes,
      {
        id: takeId(s, idFromLabel(label, 'route')),
        label,
        kind: 'success',
        to,
        event: 'StageCompleted',
        data: 'none',
        rework: false,
        effect: 'none',
      },
    ],
  }));
}

/** Every non-final step goes to the step below it, and nothing is sent back: the "straight line" case. */
export function isLinear(m: BuilderModel): boolean {
  return m.steps.every((s, i) => {
    if (s.kind === 'terminal') return true;
    const n = nextIndex(s);
    return n !== -1 && s.routes[n]?.to === m.steps[i + 1]?.uid && s.routes.length === 1;
  });
}

/** Adds a step after position `index`; the new step takes over the old target of the step before it. */
export function insertStepAfter(
  m: BuilderModel,
  index: number,
  label = 'New step',
): { model: BuilderModel; uid: string } {
  const prev = m.steps[index];
  const step = blankStep(m, label);
  const steps = [...m.steps];
  if (!prev || prev.kind === 'terminal') {
    // Nothing follows a final step: the new step goes before it.
    const at = prev ? index : steps.length;
    steps.splice(at, 0, step);
    let model: BuilderModel = { ...m, steps };
    const before = model.steps[at - 1];
    if (prev && before && before.kind !== 'terminal') {
      const i = nextIndex(before);
      const target = i !== -1 ? (before.routes[i] as BuilderRoute).to : prev.uid;
      model = setNext(setNext(model, step.uid, target), before.uid, step.uid);
    } else if (prev) model = setNext(model, step.uid, prev.uid);
    return { model, uid: step.uid };
  }
  const i = nextIndex(prev);
  const target = i !== -1 ? (prev.routes[i] as BuilderRoute).to : m.steps[index + 1]?.uid;
  steps.splice(index + 1, 0, step);
  let model: BuilderModel = { ...m, steps };
  if (target) model = setNext(model, step.uid, target);
  model = setNext(model, prev.uid, step.uid);
  return { model, uid: step.uid };
}

/** The "Add a step" button at the end of the list: the new step goes just before the final step. */
export function appendStep(m: BuilderModel, label = 'New step'): { model: BuilderModel; uid: string } {
  let at = -1;
  m.steps.forEach((s, i) => {
    if (s.kind !== 'terminal') at = i;
  });
  const lastIsTerminal = m.steps[m.steps.length - 1]?.kind === 'terminal';
  if (at === -1 || !lastIsTerminal) return insertStepAfter(m, m.steps.length - 1, label);
  return insertStepAfter(m, at, label);
}

/** Removes a step; routes into it go to where it went (or are dropped when that is a loop). */
export function removeStep(m: BuilderModel, uid: string): BuilderModel {
  const gone = m.steps.find((s) => s.uid === uid);
  if (!gone || m.steps.length <= 2) return m;
  const i = nextIndex(gone);
  const forward = i !== -1 ? (gone.routes[i] as BuilderRoute).to : undefined;
  const steps = m.steps
    .filter((s) => s.uid !== uid)
    .map((s) => ({
      ...s,
      routes: s.routes.flatMap((r) => {
        if (r.to !== uid) return [r];
        if (!forward || forward === uid || forward === s.uid) return [];
        return [{ ...r, to: forward }];
      }),
    }));
  return { ...m, steps, initial: m.initial === uid ? (steps[0]?.uid ?? m.initial) : m.initial };
}

/**
 * Moves a step up or down the list. In a straight-line workflow the flow follows the list; otherwise only the
 * order changes (routes are explicit).
 */
export function moveStep(m: BuilderModel, uid: string, dir: -1 | 1): BuilderModel {
  const i = m.steps.findIndex((s) => s.uid === uid);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= m.steps.length) return m;
  const linear = isLinear(m);
  const steps = [...m.steps];
  [steps[i], steps[j]] = [steps[j] as BuilderStep, steps[i] as BuilderStep];
  let model: BuilderModel = { ...m, steps };
  if (linear) {
    steps.forEach((s, k) => {
      const next = steps[k + 1];
      if (s.kind !== 'terminal' && next) model = setNext(model, s.uid, next.uid);
    });
  }
  return model;
}

/** Changes what kind of step this is, keeping the rest sensible (final steps have no routes, only agent steps a role). */
export function setStepKind(m: BuilderModel, uid: string, kind: StepKindValue): BuilderModel {
  const i = m.steps.findIndex((s) => s.uid === uid);
  const step = m.steps[i];
  if (!step || step.kind === kind) return m;
  let model = patchStep(m, uid, (s) => ({
    ...s,
    kind,
    role: kind === 'agent' ? s.role : null,
    routes: kind === 'terminal' ? [] : s.routes,
    ...(kind === 'subworkflow' ? {} : { subworkflow: undefined }),
  }));
  if (kind !== 'terminal' && nextIndex(model.steps[i] as BuilderStep) === -1) {
    const next = model.steps[i + 1];
    if (next) model = setNext(model, uid, next.uid);
  }
  return model;
}

export function setFirstStep(m: BuilderModel, uid: string): BuilderModel {
  return m.steps.some((s) => s.uid === uid) ? { ...m, initial: uid } : m;
}

// ------------------------------------------------------------------------------------------------ fields

export const FIELD_TYPE_LABEL: Record<CustomField['type'], string> = {
  text: 'Short text',
  markdown: 'Long text',
  list: 'List',
  number: 'Number',
  boolean: 'Yes or no',
  'url-list': 'Links',
};

export function addField(m: BuilderModel, label = ''): { model: BuilderModel; uid: string } {
  const taken = new Set(m.fields.map((f) => f.uid));
  const uid = freshUid('f', taken);
  return {
    model: { ...m, fields: [...m.fields, { uid, label, type: 'text', required: false }] },
    uid,
  };
}

export function updateField(m: BuilderModel, uid: string, patch: Partial<BuilderField>): BuilderModel {
  return { ...m, fields: m.fields.map((f) => (f.uid === uid ? { ...f, ...patch } : f)) };
}

/** Removes a field and every use of it (required by a step, a "only when" condition, a route guard). */
export function removeField(m: BuilderModel, uid: string): BuilderModel {
  return {
    ...m,
    fields: m.fields.filter((f) => f.uid !== uid),
    steps: m.steps.map((s) => ({
      ...s,
      requiredFields: s.requiredFields.filter((f) => f !== uid),
      when: s.when?.field === uid ? undefined : s.when,
      routes: s.routes.map((r) => (r.when?.field === uid ? { ...r, when: undefined } : r)),
    })),
  };
}

export const yesNoFields = (m: BuilderModel): BuilderField[] => m.fields.filter((f) => f.type === 'boolean');

export function toggleRequired(m: BuilderModel, uid: string, field: string, on: boolean): BuilderModel {
  return patchStep(m, uid, (s) => ({
    ...s,
    requiredFields: on
      ? s.requiredFields.includes(field)
        ? s.requiredFields
        : [...s.requiredFields, field]
      : s.requiredFields.filter((f) => f !== field),
  }));
}

// ------------------------------------------------------------------------------------------- validation

/** An issue as the builder shows it: plain sentence, pinned to a step and an input. */
export type BuilderIssue = Omit<ExplainedIssue, 'code' | 'issue'> & { code: string; issue?: ValidationIssue };

export interface BuilderContext {
  roles: readonly RoleDefinition[];
  departments: readonly string[];
  frozen?: FrozenIds;
}

export interface BuilderValidation {
  def: BuilderDef;
  issues: BuilderIssue[];
  errors: number;
  warnings: number;
  /** Issues per final stage id; workflow-level ones under ''. */
  byStage: Map<string, BuilderIssue[]>;
}

const asValidation = (i: DefinitionIssue): ValidationIssue => ({ rule: 0, ...i }) as ValidationIssue;

/** Runs the shared validator in the browser and words the result for the owner. `server` issues, when given, replace the local ones. */
export function validateBuilder(
  model: BuilderModel,
  ctx: BuilderContext,
  server?: readonly DefinitionIssue[],
): BuilderValidation {
  const def = toDefinition(model, { frozen: ctx.frozen });
  const full = { ...def, version: 1, builtIn: false };
  let raw: ValidationIssue[];
  const parsed = WorkflowDefinitionSchema.safeParse(full);
  if (server && server.length > 0) raw = server.map(asValidation);
  else if (!parsed.success)
    raw = parsed.error.issues.map((i) => ({
      severity: 'error' as const,
      rule: 0,
      code: 'invalid_schema' as const,
      message: `${i.path.join('.') || '(root)'}: ${i.message}`,
    }));
  else
    raw = validateCustomWorkflow(parsed.data, ctx.roles, {
      builtinWorkflowKeys: BUILTIN_WORKFLOWS.map((w) => w.key),
      departments: ctx.departments,
    });
  const issues: BuilderIssue[] = explainIssues(raw, def as { stages: WorkflowDefinitionInput['stages'] });
  if (ctx.frozen) {
    for (const gone of missingFrozenIds(ctx.frozen, def as { stages: WorkflowDefinitionInput['stages'] })) {
      const stage = gone.includes('.') ? (gone.split('.')[0] as string) : gone;
      issues.push({
        severity: 'warning',
        code: 'frozen_id_removed',
        text: gone.includes('.')
          ? `A route of the approved step '${stage}' was removed. Cards that are already running keep the old version; roles may still point at it.`
          : `The approved step '${gone}' was removed. Cards that are already running keep the old version; roles that work it will need updating.`,
        field: 'steps',
      });
    }
  }
  if (!model.name.trim())
    issues.unshift({
      severity: 'error',
      code: 'name_missing',
      text: 'Give the workflow a name.',
      field: 'details',
    });
  const byStage = new Map<string, BuilderIssue[]>();
  for (const i of issues) byStage.set(i.stageId ?? '', [...(byStage.get(i.stageId ?? '') ?? []), i]);
  for (const list of byStage.values())
    list.sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'));
  return {
    def,
    issues,
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    byStage,
  };
}

// --------------------------------------------------------------------------------------------- helpers

/** Why the Advanced panel should open by default: parts of the workflow the guided form does not show fully. */
export function builderCaveats(m: BuilderModel): string[] {
  const out: string[] = [];
  for (const s of m.steps) {
    const extra = otherRoutes(s);
    if (extra.length > 0) out.push(`'${s.label}' has ${extra.length} more route(s) than the form shows`);
    if (s.routes.some((r) => r.when)) out.push(`'${s.label}' has a route that applies only in some cases`);
  }
  return out;
}

/** Roles a step may name: the owner's active roles, else the newest draft of each (what the designer validates against). */
export function builderRoles(cat: OrgCatalogueResponse): RoleDefinition[] {
  return cat.roles
    .map(
      (r) =>
        (
          r.versions.find((v) => v.status === 'active') ??
          r.versions.find((v) => v.status === 'draft' || v.status === 'pending_approval')
        )?.definition,
    )
    .filter((d): d is RoleDefinition => !!d && d.key !== 'devops');
}

/** All workflow keys in the catalogue (a new workflow must not reuse one). */
export const takenWorkflowKeys = (cat: OrgCatalogueResponse): Set<string> =>
  new Set([...cat.workflows.map((w) => w.key), ...BUILTIN_WORKFLOWS.map((w) => w.key)]);

/** The ids frozen by the newest approved version (active, else the newest superseded one) of a workflow. */
export function frozenFor(cat: OrgCatalogueResponse, key: string): FrozenIds {
  const versions = cat.workflows.find((w) => w.key === key)?.versions ?? [];
  const approved =
    versions.find((v) => v.status === 'active') ?? versions.find((v) => v.status === 'superseded');
  return frozenIdsOf(approved?.definition as WorkflowDefinitionInput | undefined);
}

export const KIND_LABEL: Record<StepKindValue, string> = {
  manual: 'Starts here (someone fills in the card)',
  agent: 'Work done by an agent',
  subworkflow: 'Starts another workflow',
  terminal: 'Finished',
};

export const CARD_TYPE_LABEL: Record<string, string> = {
  feature: 'Feature',
  bug: 'Bug',
  support: 'Support request',
  refactor: 'Refactor',
  docs: 'Documentation',
};

/** A plain-text outline of the draft, for the BA chat ("here is what I am looking at"). */
export function describeDraft(m: BuilderModel, draftId?: string): string {
  const label = (uid: string) => m.steps.find((s) => s.uid === uid)?.label || uid;
  const lines = [
    `I am working on the workflow "${m.name || 'Untitled'}" (key ${m.key})${draftId ? `, draft ${draftId}` : ', not saved yet'}.`,
    'Its steps right now:',
  ];
  m.steps.forEach((s, i) => {
    const bits: string[] = [];
    if (s.kind === 'agent') bits.push(s.role ? `done by ${s.role}` : 'no role yet');
    else if (s.kind === 'manual') bits.push('starts here');
    else if (s.kind === 'terminal') bits.push('final step');
    else bits.push('starts another workflow');
    const n = nextIndex(s);
    if (n !== -1) bits.push(`then ${label((s.routes[n] as BuilderRoute).to)}`);
    const b = sendBackIndex(s);
    if (b !== -1) bits.push(`sent back to ${label((s.routes[b] as BuilderRoute).to)} if not good enough`);
    if (s.doneCriteria) bits.push(`done when: ${s.doneCriteria}`);
    lines.push(`${i + 1}. ${s.label || 'Untitled step'} (${bits.join('; ')})`);
  });
  if (m.fields.length > 0)
    lines.push(
      `Card fields: ${m.fields.map((f) => `${f.label || f.key || f.uid} (${FIELD_TYPE_LABEL[f.type]})`).join(', ')}.`,
    );
  return lines.join('\n');
}
