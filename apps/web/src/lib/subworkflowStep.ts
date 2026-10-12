import {
  BUILTIN_WORKFLOWS,
  CARD_COLUMN_FIELDS,
  effectiveSubworkflowStart,
  type OrgCatalogueResponse,
  type SubworkflowConfigInput,
  type SubworkflowLookup,
  type SubworkflowTargetsResponse,
  type WorkflowDefinition,
} from '@aom/shared';
import {
  type BuilderModel,
  type BuilderStep,
  ensureFailedRoute,
  failedRouteIndex,
  newSubworkflowConfig,
  setFailedRoute,
  updateStep,
} from './builder.ts';

/**
 * Pure helpers of the sub-workflow step editor (docs/design/workflow-builder.md section 4). The editor edits
 * `step.subworkflow`; parent-card field references in it are field uids (or raw keys of built-in card fields), turned
 * into keys by `toDefinition`.
 */

export type SubworkflowSourceKind = 'field' | 'value' | 'template';
export type FieldsInRow = NonNullable<SubworkflowConfigInput['fieldsIn']>[number];

export const sourceKindOf = (from: FieldsInRow['from']): SubworkflowSourceKind =>
  'field' in from ? 'field' : 'template' in from ? 'template' : 'value';

/** The step's settings with every default filled in. */
export function configOf(step: BuilderStep) {
  const c = step.subworkflow ?? newSubworkflowConfig();
  return {
    workflowKey: c.workflowKey ?? '',
    project: c.project ?? ('same' as const),
    cardType: c.cardType,
    mode: c.mode ?? ('wait' as const),
    start: c.start,
    fieldsIn: c.fieldsIn ?? [],
    fieldsOut: c.fieldsOut ?? [],
    onFailure: c.onFailure ?? ('fail' as const),
  };
}

const patchConfig = (
  m: BuilderModel,
  uid: string,
  f: (c: ReturnType<typeof configOf>) => Partial<SubworkflowConfigInput>,
): BuilderModel => {
  const step = m.steps.find((s) => s.uid === uid);
  if (!step) return m;
  const c = configOf(step);
  const next = { ...c, ...f(c) } as SubworkflowConfigInput;
  // `start` and `cardType` are optional keys: an absent value must not stay behind as `undefined`.
  if (next.start === undefined) delete next.start;
  if (next.cardType === undefined || next.cardType === '') delete next.cardType;
  return updateStep(m, uid, { subworkflow: next });
};

/** Picks the workflow to start. Mappings and the card type belong to the old target, so they are cleared. */
export function setTarget(m: BuilderModel, uid: string, workflowKey: string): BuilderModel {
  const step = m.steps.find((s) => s.uid === uid);
  if (!step || configOf(step).workflowKey === workflowKey) return m;
  return patchConfig(m, uid, () => ({ workflowKey, cardType: undefined, fieldsIn: [], fieldsOut: [] }));
}

export const setTargetProject = (m: BuilderModel, uid: string, projectId: string | 'same'): BuilderModel =>
  patchConfig(m, uid, () => ({ project: projectId === 'same' ? 'same' : { projectId } }));

export const setCardType = (m: BuilderModel, uid: string, cardType: string): BuilderModel =>
  patchConfig(m, uid, () => ({ cardType: cardType || undefined }));

/** Wait or carry on. Carrying on has nothing to copy back and nothing to fail on, so those go. */
export function setMode(m: BuilderModel, uid: string, mode: 'wait' | 'continue'): BuilderModel {
  let model = patchConfig(m, uid, () => (mode === 'continue' ? { mode, fieldsOut: [] } : { mode }));
  const step = model.steps.find((s) => s.uid === uid) as BuilderStep;
  if (mode === 'continue') {
    const i = failedRouteIndex(step);
    if (i !== -1) model = setFailedRoute(model, uid, null);
  } else model = ensureFailedRoute(model, uid);
  return model;
}

export function setStart(m: BuilderModel, uid: string, start: 'draft' | 'queued' | ''): BuilderModel {
  return patchConfig(m, uid, () => ({ start: start || undefined }));
}

export function setOnFailure(m: BuilderModel, uid: string, onFailure: 'fail' | 'continue'): BuilderModel {
  const model = patchConfig(m, uid, () => ({ onFailure }));
  return onFailure === 'fail' ? ensureFailedRoute(model, uid) : setFailedRoute(model, uid, null);
}

// ---------------------------------------------------------------------------------------------- mappings

export function addFieldIn(m: BuilderModel, uid: string, to: string, value: unknown = ''): BuilderModel {
  return patchConfig(m, uid, (c) => ({
    fieldsIn: [...c.fieldsIn, { to, from: { value } }],
  }));
}

export function setFieldIn(m: BuilderModel, uid: string, index: number, row: FieldsInRow): BuilderModel {
  return patchConfig(m, uid, (c) => ({ fieldsIn: c.fieldsIn.map((r, i) => (i === index ? row : r)) }));
}

export const removeFieldIn = (m: BuilderModel, uid: string, index: number): BuilderModel =>
  patchConfig(m, uid, (c) => ({ fieldsIn: c.fieldsIn.filter((_, i) => i !== index) }));

/** A fresh source of the given kind, keeping what can be kept. */
export function sourceOfKind(
  kind: SubworkflowSourceKind,
  parentFields: readonly { key: string }[],
): FieldsInRow['from'] {
  if (kind === 'field') return { field: parentFields[0]?.key ?? '' };
  if (kind === 'template') return { template: '' };
  return { value: '' };
}

export function addFieldOut(m: BuilderModel, uid: string, from: string, to: string): BuilderModel {
  return patchConfig(m, uid, (c) => ({ fieldsOut: [...c.fieldsOut, { from, to }] }));
}

export function setFieldOut(
  m: BuilderModel,
  uid: string,
  index: number,
  row: { from: string; to: string },
): BuilderModel {
  return patchConfig(m, uid, (c) => ({ fieldsOut: c.fieldsOut.map((r, i) => (i === index ? row : r)) }));
}

export const removeFieldOut = (m: BuilderModel, uid: string, index: number): BuilderModel =>
  patchConfig(m, uid, (c) => ({ fieldsOut: c.fieldsOut.filter((_, i) => i !== index) }));

// ---------------------------------------------------------------------------------------------- targets

type TargetWorkflow = SubworkflowTargetsResponse['workflows'][number];

/** Fields of this workflow's own cards the step can read or write: its custom fields (by uid), then the built-in ones. */
export function parentFieldChoices(m: BuilderModel): Array<{ key: string; label: string; kind: string }> {
  const custom = m.fields.map((f) => ({
    key: f.uid,
    label: f.label || f.key || 'Unnamed information',
    kind: f.type === 'boolean' ? 'boolean' : f.type,
  }));
  const builtIn = Object.entries(CARD_COLUMN_FIELDS).map(([key, v]) => ({
    key,
    label: v.label,
    kind: v.kind,
  }));
  return [...custom, ...builtIn.filter((b) => b.key === 'title' || b.key === 'priority')];
}

/** What starting the child will do given the current mappings (`effectiveSubworkflowStart` on the target's needs). */
export function startHint(
  cfg: ReturnType<typeof configOf>,
  target: TargetWorkflow | undefined,
): { effective: 'draft' | 'queued'; missing: string[] } | null {
  if (!target) return null;
  const required = target.fields.filter((f) => f.required).map((f) => f.key);
  const mapped = new Set(cfg.fieldsIn.map((f) => f.to));
  return {
    effective: effectiveSubworkflowStart({ start: cfg.start, fieldsIn: cfg.fieldsIn }, required),
    missing: required.filter((k) => !mapped.has(k)),
  };
}

/**
 * The lookup `validateSubworkflowTargets` needs, in the browser: approved workflows from the catalogue (the active
 * version of each key, built-ins included) and, for another project, what that project has enabled. A project the
 * caller is not a member of is not listed in `targets`: it is not judged here (the server does when saving).
 */
export function buildSubworkflowLookup(
  cat: Pick<OrgCatalogueResponse, 'workflows'> | undefined,
  targets: SubworkflowTargetsResponse | undefined,
): SubworkflowLookup {
  const defs = new Map<string, WorkflowDefinition>();
  for (const w of BUILTIN_WORKFLOWS) defs.set(w.key, w);
  for (const w of cat?.workflows ?? []) {
    const active = w.versions.find((v) => v.status === 'active');
    if (active) defs.set(w.key, active.definition);
  }
  return (workflowKey, project) => {
    const definition = defs.get(workflowKey);
    if (!definition) return undefined;
    const proj = project === 'same' ? undefined : targets?.projects.find((p) => p.id === project.projectId);
    return {
      definition,
      approved: true,
      sameOrg: true,
      enabledInProject: proj ? proj.enabledWorkflows.includes(workflowKey) : true,
    };
  };
}

/** Child field choices for a mapping: all of the target's fields, required ones first. */
export const childFieldChoices = (target: TargetWorkflow | undefined) =>
  [...(target?.fields ?? [])].sort((a, b) => Number(b.required) - Number(a.required));
