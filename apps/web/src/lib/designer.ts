import type {
  DefinitionIssue,
  RoleDefinition,
  RoleDraftInput,
  WorkflowDefinition,
  WorkflowDraftInput,
} from '@aom/shared';

// ------------------------------------------------------------------------ workflow graph preview

export interface GraphNode {
  id: string;
  label: string;
  kind: 'agent' | 'manual' | 'terminal';
  role: string | null;
  layer: number;
  row: number;
  x: number;
  y: number;
  /** Not reachable from the first stage: drawn apart and flagged. */
  unreachable: boolean;
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  failure: boolean;
  /** Goes back to an earlier (or the same) layer: drawn as a loop. */
  back: boolean;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

export const NODE_W = 132;
export const NODE_H = 46;
const GAP_X = 52;
const GAP_Y = 36;

/**
 * Lays a workflow out left to right by distance from the first stage (breadth first). Pure and deterministic, so the
 * preview can be tested without a browser. Stages that cannot be reached go to a last column and are flagged.
 */
export function layoutWorkflow(def: Pick<WorkflowDefinition, 'initialStage' | 'stages'>): Graph {
  const byId = new Map(def.stages.map((s) => [s.id, s]));
  const layerOf = new Map<string, number>();
  if (byId.has(def.initialStage)) {
    layerOf.set(def.initialStage, 0);
    const queue = [def.initialStage];
    while (queue.length) {
      const id = queue.shift() as string;
      for (const o of byId.get(id)?.outcomes ?? []) {
        if (byId.has(o.to) && !layerOf.has(o.to)) {
          layerOf.set(o.to, (layerOf.get(id) as number) + 1);
          queue.push(o.to);
        }
      }
    }
  }
  const maxReached = Math.max(-1, ...layerOf.values());
  const orphanLayer = maxReached + 1;
  const rows = new Map<number, number>();
  const nodes: GraphNode[] = def.stages.map((s) => {
    const reached = layerOf.has(s.id);
    const layer = layerOf.get(s.id) ?? orphanLayer;
    const row = rows.get(layer) ?? 0;
    rows.set(layer, row + 1);
    return {
      id: s.id,
      label: s.label || s.id,
      kind: s.kind,
      role: s.claimRole,
      layer,
      row,
      x: layer * (NODE_W + GAP_X),
      y: row * (NODE_H + GAP_Y),
      unreachable: !reached,
    };
  });
  const layer = new Map(nodes.map((n) => [n.id, n.layer]));
  const edges: GraphEdge[] = [];
  for (const s of def.stages)
    for (const o of s.outcomes)
      if (byId.has(o.to))
        edges.push({
          id: `${s.id}.${o.id}`,
          from: s.id,
          to: o.to,
          label: o.id,
          failure: o.kind === 'failure',
          back: (layer.get(o.to) as number) <= (layer.get(s.id) as number),
        });
  const layers = Math.max(1, ...nodes.map((n) => n.layer + 1));
  const tallest = Math.max(1, ...rows.values());
  return {
    nodes,
    edges,
    width: layers * NODE_W + (layers - 1) * GAP_X,
    height: tallest * NODE_H + (tallest - 1) * GAP_Y + 28,
  };
}

// ----------------------------------------------------------------------------------- issues

/** Issues of a stage (with its outcomes), and the ones that belong to the workflow as a whole. */
export function groupIssues(issues: readonly DefinitionIssue[]): {
  byStage: Map<string, DefinitionIssue[]>;
  general: DefinitionIssue[];
} {
  const byStage = new Map<string, DefinitionIssue[]>();
  const general: DefinitionIssue[] = [];
  for (const i of issues) {
    if (!i.stageId) general.push(i);
    else byStage.set(i.stageId, [...(byStage.get(i.stageId) ?? []), i]);
  }
  return { byStage, general };
}

export const errorCount = (issues: readonly DefinitionIssue[]) =>
  issues.filter((i) => i.severity === 'error').length;

// ----------------------------------------------------------------------- drafts to and from forms

export const blankWorkflow = (): WorkflowDraftInput => ({
  key: '',
  name: '',
  fieldSet: 'custom',
  customFields: [],
  cardTypes: ['support'],
  initialStage: 'intake',
  stages: [
    {
      id: 'intake',
      label: 'Intake',
      column: 'Intake',
      kind: 'manual',
      claimRole: null,
      seniorOnly: false,
      requiredFields: [],
      doneCriteria: '',
      outcomes: [
        {
          id: 'ready',
          label: 'Ready',
          kind: 'success',
          to: 'work',
          event: 'CardSpecified',
          data: 'none',
          rework: false,
          effect: 'none',
        },
      ],
      worktree: 'none',
      rebaseBefore: false,
      maxShiftMinutes: 60,
      requiredCapabilities: [],
    },
    {
      id: 'work',
      label: 'Work',
      column: 'Work',
      kind: 'agent',
      claimRole: null,
      seniorOnly: false,
      requiredFields: [],
      doneCriteria: '',
      outcomes: [
        {
          id: 'done',
          label: 'Done',
          kind: 'success',
          to: 'finished',
          event: 'StageCompleted',
          data: 'none',
          rework: false,
          effect: 'none',
        },
      ],
      worktree: 'none',
      rebaseBefore: false,
      maxShiftMinutes: 60,
      requiredCapabilities: [],
    },
    {
      id: 'finished',
      label: 'Finished',
      column: 'Done',
      kind: 'terminal',
      claimRole: null,
      seniorOnly: false,
      requiredFields: [],
      doneCriteria: '',
      outcomes: [],
      worktree: 'none',
      rebaseBefore: false,
      maxShiftMinutes: 60,
      requiredCapabilities: [],
    },
  ],
});

/** A stored definition as the draft input for its next version (the server assigns the version number). */
export function workflowToInput(def: WorkflowDefinition): WorkflowDraftInput {
  const { version: _v, builtIn: _b, ...rest } = def;
  return structuredClone(rest) as WorkflowDraftInput;
}

export function roleToInput(def: RoleDefinition): RoleDraftInput {
  const { version: _v, builtIn: _b, ...rest } = def;
  return structuredClone(rest) as RoleDraftInput;
}

export const blankRole = (): RoleDraftInput => ({
  key: '',
  name: '',
  purpose: '',
  instructions: '',
  coreRules: [],
  seniorityLevels: ['junior', 'senior'],
  defaultModel: { runtime: 'claude-code', model: 'sonnet' },
  permissions: {
    allowedTools: ['read', 'shell'],
    deniedShellPatterns: [],
    writableGlobs: null,
    mayCommit: false,
    browser: false,
    riskTiers: ['small', 'large'],
    repoIds: null,
  },
  skills: [],
  claimableStages: [],
});

/** `a, b ,c` or one per line to a clean list. */
export const splitList = (s: string): string[] =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Stages of the workflow that a custom role may claim, as `workflow.stage` text for the role form. */
export const claimText = (c: Array<{ workflowKey: string; stageId: string }>): string =>
  c.map((x) => `${x.workflowKey}.${x.stageId}`).join(', ');

export function parseClaims(s: string): Array<{ workflowKey: string; stageId: string }> {
  return splitList(s).map((x) => {
    const [workflowKey = '', stageId = '*'] = x.split('.');
    return { workflowKey: workflowKey.trim(), stageId: stageId.trim() || '*' };
  });
}

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const stageId = (s: string): string =>
  slug(s)
    .replace(/-/g, '_')
    .replace(/^[^a-z]+/, '');

// ----------------------------------------------------------------------------- department filter

/** Departments present on a list of items, for the filter dropdowns (sorted, without blanks). */
export function departmentsOf(items: ReadonlyArray<{ department?: string | null }>): string[] {
  return [...new Set(items.map((i) => i.department).filter((d): d is string => !!d))].sort();
}

export function inDepartment<T extends { department?: string | null }>(
  items: readonly T[],
  department: string,
): T[] {
  return department ? items.filter((i) => i.department === department) : [...items];
}
