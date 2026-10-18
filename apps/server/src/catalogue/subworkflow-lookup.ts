import {
  fieldCatalogue,
  LEGACY_CODE_V6_KEY,
  requiredChildFields,
  type SubworkflowLookup,
  type SubworkflowTarget,
  type SubworkflowTargetsResponse,
  subworkflowStages,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
} from '@aom/shared';
import { type Queryable, rows } from '../db/sql.ts';
import { enabledWorkflows } from './project-workflows.ts';

/** Does this definition start a sub-workflow at all? (Most do not: the lookup is then never built.) */
export function hasSubworkflowStages(def: unknown): boolean {
  const parsed = WorkflowDefinitionSchema.safeParse(def);
  return parsed.success && subworkflowStages(parsed.data).length > 0;
}

interface Entry {
  definition: WorkflowDefinition;
  approved: boolean;
  version: number;
}

/**
 * The `subworkflowLookup` the validators need (rule 10: target exists, is approved and enabled, no cycle, depth), built
 * from the registry in one pass because the lookup itself is synchronous. `def` is the workflow being edited (an org
 * workflow, or the base of a variant): `undefined` is returned when it starts no sub-workflow, so the common save pays
 * nothing. `ownProjectId` is the project of a variant; an organisation workflow has none, so `'same'` targets are
 * judged by their approval only (the project that runs the card is not known yet; the server checks it when the stage
 * is entered).
 */
export async function subworkflowLookupFor(
  db: Queryable,
  orgId: string,
  def: unknown,
  ownProjectId: string | null = null,
): Promise<SubworkflowLookup | undefined> {
  if (!hasSubworkflowStages(def)) return undefined;
  const versions = await rows(
    db,
    `SELECT org_id, key, version, status, definition, project_id FROM workflow_versions
      WHERE (org_id = $1 OR org_id IS NULL) AND status IN ('active','draft','pending_approval')
      ORDER BY (org_id IS NULL), version DESC`,
    [orgId],
  );
  // (project or '') + key -> the newest active version; else the newest one in the works (not approved).
  const best = new Map<string, Entry>();
  for (const r of versions) {
    const k = `${r.project_id ?? ''}\u0000${r.key}`;
    const approved = r.status === 'active';
    const cur = best.get(k);
    if (cur && (cur.approved || !approved)) continue;
    const parsed = WorkflowDefinitionSchema.safeParse(r.definition);
    if (!parsed.success) continue;
    best.set(k, { definition: parsed.data, approved, version: r.version });
  }
  const enabled = new Map<string, Set<string>>();
  for (const r of await rows<{ id: string; workflow_key: string }>(
    db,
    'SELECT id, workflow_key FROM projects WHERE org_id = $1',
    [orgId],
  ))
    enabled.set(r.id, new Set([r.workflow_key]));
  for (const r of await rows<{ project_id: string; workflow_key: string }>(
    db,
    `SELECT pw.project_id, pw.workflow_key FROM project_workflows pw JOIN projects p ON p.id = pw.project_id
      WHERE p.org_id = $1`,
    [orgId],
  ))
    enabled.get(r.project_id)?.add(r.workflow_key);

  return (workflowKey, project): SubworkflowTarget | undefined => {
    const projectId = project === 'same' ? ownProjectId : project.projectId;
    const entry =
      (projectId ? best.get(`${projectId}\u0000${workflowKey}`) : undefined) ??
      best.get(`\u0000${workflowKey}`);
    if (!entry) return undefined;
    const known = projectId ? enabled.get(projectId) : undefined;
    return {
      definition: entry.definition,
      approved: entry.approved,
      // An unknown project id is another organisation's (or none): not the same organisation.
      sameOrg: projectId ? !!known : true,
      enabledInProject: projectId ? !!known?.has(workflowKey) : true,
    };
  };
}

/**
 * What the builder's sub-workflow step offers (`GET /api/subworkflow-targets`): the approved workflows of the
 * organization (internal bug-fix machinery left out) and the projects `userId` is an active member of, each with the
 * workflows enabled there. A project the user is not a member of is never listed (a step can only start cards in
 * projects its owner belongs to).
 */
export async function subworkflowTargets(
  db: Queryable,
  orgId: string,
  userId: string,
): Promise<SubworkflowTargetsResponse> {
  const versions = await rows(
    db,
    `SELECT DISTINCT ON (org_id, key) org_id, definition FROM workflow_versions
      WHERE (org_id IS NULL OR org_id = $1) AND status = 'active' AND project_id IS NULL AND key <> '${LEGACY_CODE_V6_KEY}'
      ORDER BY org_id NULLS FIRST, key, version DESC`,
    [orgId],
  );
  // An organization workflow shadows a built-in one of the same key.
  const byKey = new Map<string, { def: WorkflowDefinition; builtIn: boolean }>();
  for (const r of versions) {
    const parsed = WorkflowDefinitionSchema.safeParse(r.definition);
    if (parsed.success) byKey.set(parsed.data.key, { def: parsed.data, builtIn: r.org_id === null });
  }
  const workflows = [...byKey.values()]
    .filter(({ def }) => def.key !== 'code-bugfix')
    .map(({ def, builtIn }) => {
      const required = new Set(requiredChildFields(def));
      return {
        key: def.key,
        name: def.name,
        builtIn,
        cardTypes: def.cardTypes,
        fields: Object.entries(fieldCatalogue(def.fieldSet, def.customFields)).map(([key, m]) => ({
          key,
          label: m.label,
          kind: m.kind,
          required: required.has(key),
        })),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const projects = await rows(
    db,
    `SELECT p.* FROM projects p JOIN project_members pm ON pm.project_id = p.id
      WHERE p.org_id = $1 AND pm.user_id = $2 AND pm.status = 'active' AND p.status = 'active' AND p.kind <> 'interest'
      ORDER BY p.name`,
    [orgId, userId],
  );
  return {
    workflows,
    projects: await Promise.all(
      projects.map(async (p) => ({
        id: p.id as string,
        key: p.key as string,
        name: p.name as string,
        enabledWorkflows: (await enabledWorkflows(db, p)).map((e) => e.workflowKey),
      })),
    ),
  };
}
