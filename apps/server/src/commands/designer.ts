import { randomUUID } from 'node:crypto';
import {
  BUILTIN_ROLES,
  BUILTIN_WORKFLOWS,
  type CreateDepartmentRequest,
  DEFINITION_FORMAT,
  DESK_SUBKIND_DEFINITION,
  type DefinitionIssue,
  type DepartmentDto,
  type DraftResponse,
  definitionVaultPath,
  type ExtendRoleRequest,
  type OrgCatalogueResponse,
  type RoleDefinition,
  RoleDefinitionSchema,
  type RoleDraftInput,
  renderDefinitionFile,
  type SubmitResponse,
  streamId,
  type ValidateResponse,
  type ValidationIssue,
  validateCustomWorkflow,
  validateRoleDefinition,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  type WorkflowDraftInput,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { projectRole } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import type { AppendInput, StoredEvent } from '../eventstore/types.ts';
import { agentActor, orgScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { enqueueVaultWrite } from './vaults.ts';

/** Who designs: the manager (through the Organization page) or the BA in a design chat. */
export type Designer = { kind: 'user'; userId: string } | { kind: 'agent'; agentId: string };

const authorOf = (d: Designer) =>
  d.kind === 'user' ? ({ kind: 'user', id: d.userId } as const) : ({ kind: 'agent', id: d.agentId } as const);
const actorOf = (d: Designer) => (d.kind === 'user' ? userActor(d.userId) : agentActor(d.agentId));

const BUILTIN_ROLE_KEYS = BUILTIN_ROLES.map((r) => r.key);
const BUILTIN_WORKFLOW_KEYS = BUILTIN_WORKFLOWS.map((w) => w.key);
const BUILTIN_DEPARTMENTS = [
  ...new Set(
    [...BUILTIN_ROLES.map((r) => r.department), ...BUILTIN_WORKFLOWS.map((w) => w.department)].filter(
      (d): d is string => !!d,
    ),
  ),
];

const issueOfWorkflow = (i: ValidationIssue): DefinitionIssue => ({
  severity: i.severity,
  code: i.code,
  message: i.message,
  stageId: i.stageId,
  outcomeId: i.outcomeId,
  rule: i.rule,
});

// ------------------------------------------------------------------------------------------- context

/**
 * The organization whose catalogue a request is about: the caller's own, or (with `projectId`) the one that owns the
 * project. Everyone in a project may read its owner's catalogue; only the owner may change it.
 */
export async function catalogueOrg(
  db: Queryable,
  user: { id: string },
  projectId: string | undefined,
  write: boolean,
): Promise<{ orgId: string; isOwner: boolean }> {
  if (!projectId) return { orgId: user.id, isOwner: true };
  const role = await projectRole(db, user.id, projectId);
  if (!role) throw notFound('project not found');
  const p = await one<{ org_id: string }>(db, 'SELECT org_id FROM projects WHERE id=$1', [projectId]);
  if (!p) throw notFound('project not found');
  const isOwner = p.org_id === user.id;
  if (write && !isOwner)
    throw forbidden(
      'only the organization owner can change the role catalogue, workflows and standing orders',
    );
  return { orgId: p.org_id, isOwner };
}

export async function departmentNames(db: Queryable, orgId: string): Promise<string[]> {
  const own = await rows<{ name: string }>(db, 'SELECT name FROM departments WHERE org_id=$1', [orgId]);
  return [...BUILTIN_DEPARTMENTS, ...own.map((d) => d.name)];
}

/**
 * Roles a workflow's stages may name: built-in and the organization's active roles; while designing (`withDrafts`)
 * also its own drafts and pending ones, so a role and the workflow that uses it can be drafted together.
 */
export async function roleCatalogue(
  db: Queryable,
  orgId: string,
  withDrafts: boolean,
): Promise<RoleDefinition[]> {
  const statuses = withDrafts ? ['active', 'draft', 'pending_approval'] : ['active'];
  const list = await rows(
    db,
    `SELECT DISTINCT ON (key) key, definition FROM role_definitions
      WHERE (org_id IS NULL OR org_id = $1) AND status = ANY($2::text[])
      ORDER BY key, (org_id IS NULL), version DESC`,
    [orgId, statuses],
  );
  return list.map((r) => RoleDefinitionSchema.parse(r.definition));
}

async function validationContexts(db: Queryable, orgId: string) {
  const departments = await departmentNames(db, orgId);
  return {
    role: { builtinRoleKeys: BUILTIN_ROLE_KEYS, builtinWorkflowKeys: BUILTIN_WORKFLOW_KEYS, departments },
    workflow: { builtinWorkflowKeys: BUILTIN_WORKFLOW_KEYS, departments },
  };
}

// ----------------------------------------------------------------------------------------- role drafts

const toRoleDef = (input: RoleDraftInput, version: number): RoleDefinition =>
  ({ ...input, version, builtIn: false }) as RoleDefinition;

function parseOrThrow<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: any } },
  value: unknown,
  what: string,
): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issues: DefinitionIssue[] = (r.error.issues as Array<{ path: unknown[]; message: string }>).map(
    (i) => ({
      severity: 'error',
      code: 'invalid_schema',
      message: `${i.path.join('.') || '(root)'}: ${i.message}`,
    }),
  );
  throw unprocessable('invalid_definition', `the ${what} is not valid: ${issues[0]?.message}`, { issues });
}

async function nextVersion(
  tx: Queryable,
  table: 'role_definitions' | 'workflow_versions',
  orgId: string,
  key: string,
) {
  const r = await one<{ v: number | null }>(
    tx,
    `SELECT max(version) AS v FROM ${table} WHERE org_id=$1 AND key=$2`,
    [orgId, key],
  );
  return Number(r?.v ?? 0) + 1;
}

/**
 * Saves a role draft: a new version of `input.key`, or (with `id`, or `upsert` when the key already has an open draft)
 * a change to the open draft. Drafts may carry issues; they are shown inline and block submission.
 */
export async function saveRoleDraft(
  ctx: Ctx,
  designer: Designer,
  orgId: string,
  input: RoleDraftInput,
  opts: { id?: string; upsert?: boolean } = {},
): Promise<DraftResponse> {
  return withAppendTx(ctx.pool, async (tx) => {
    if (BUILTIN_ROLE_KEYS.includes(input.key))
      throw conflict(
        'builtin_protected',
        `'${input.key}' is a built-in role: it cannot be replaced or removed`,
      );
    let existing = opts.id
      ? await one(tx, 'SELECT * FROM role_definitions WHERE id=$1 AND org_id=$2 FOR UPDATE', [opts.id, orgId])
      : await one(
          tx,
          `SELECT * FROM role_definitions WHERE org_id=$1 AND key=$2 AND status IN ('draft','pending_approval')
            ORDER BY version DESC LIMIT 1 FOR UPDATE`,
          [orgId, input.key],
        );
    if (opts.id && !existing) throw notFound('role draft not found');
    if (existing && opts.id && existing.key !== input.key)
      throw badRequest('key_immutable', 'the key of a draft cannot change: draft a new role instead');
    if (existing && existing.status === 'pending_approval')
      throw conflict(
        'pending_approval',
        `'${input.key}' v${existing.version} waits for your approval on the desk`,
      );
    if (existing && !opts.id && !opts.upsert)
      throw conflict('draft_exists', `'${input.key}' already has an open draft`, { id: existing.id });
    if (existing && existing.status !== 'draft') existing = undefined;
    const ctxs = await validationContexts(tx, orgId);
    const version = existing ? existing.version : await nextVersion(tx, 'role_definitions', orgId, input.key);
    const def = parseOrThrow(RoleDefinitionSchema, toRoleDef(input, version), 'role');
    const issues = validateRoleDefinition(def, ctxs.role).map((i): DefinitionIssue => ({ ...i }));
    const id = (existing?.id as string | undefined) ?? randomUUID();
    const ev: AppendInput = existing
      ? {
          streamId: streamId.role(orgId, def.key),
          event: { type: 'RoleDraftUpdated', payload: { roleVersionId: id, definition: def } },
          actor: actorOf(designer),
          scope: orgScope(orgId),
        }
      : {
          streamId: streamId.role(orgId, def.key),
          event: {
            type: 'RoleVersionRegistered',
            payload: {
              roleVersionId: id,
              orgId,
              key: def.key,
              version,
              definition: def,
              status: 'draft',
              draftedBy: authorOf(designer),
            },
          },
          actor: actorOf(designer),
          scope: orgScope(orgId),
        };
    await ctx.store.append([ev], { tx });
    return { id, key: def.key, version, status: 'draft' as const, issues };
  });
}

// -------------------------------------------------------------------------------------- workflow drafts

export async function saveWorkflowDraft(
  ctx: Ctx,
  designer: Designer,
  orgId: string,
  input: WorkflowDraftInput,
  opts: { id?: string; upsert?: boolean } = {},
): Promise<DraftResponse> {
  return withAppendTx(ctx.pool, async (tx) => {
    if (BUILTIN_WORKFLOW_KEYS.includes(input.key))
      throw conflict(
        'builtin_protected',
        `'${input.key}' is a built-in workflow: it cannot be replaced or removed`,
      );
    let existing = opts.id
      ? await one(tx, 'SELECT * FROM workflow_versions WHERE id=$1 AND org_id=$2 FOR UPDATE', [
          opts.id,
          orgId,
        ])
      : await one(
          tx,
          `SELECT * FROM workflow_versions WHERE org_id=$1 AND key=$2 AND status IN ('draft','pending_approval')
            ORDER BY version DESC LIMIT 1 FOR UPDATE`,
          [orgId, input.key],
        );
    if (opts.id && !existing) throw notFound('workflow draft not found');
    if (existing && opts.id && existing.key !== input.key)
      throw badRequest('key_immutable', 'the key of a draft cannot change: draft a new workflow instead');
    if (existing && existing.status === 'pending_approval')
      throw conflict(
        'pending_approval',
        `'${input.key}' v${existing.version} waits for your approval on the desk`,
      );
    if (existing && !opts.id && !opts.upsert)
      throw conflict('draft_exists', `'${input.key}' already has an open draft`, { id: existing.id });
    if (existing && existing.status !== 'draft') existing = undefined;
    const version = existing
      ? existing.version
      : await nextVersion(tx, 'workflow_versions', orgId, input.key);
    const def = parseOrThrow(
      WorkflowDefinitionSchema,
      { ...input, version, builtIn: false },
      'workflow',
    ) as WorkflowDefinition;
    const ctxs = await validationContexts(tx, orgId);
    const issues = validateCustomWorkflow(def, await roleCatalogue(tx, orgId, true), ctxs.workflow).map(
      issueOfWorkflow,
    );
    const id = (existing?.id as string | undefined) ?? randomUUID();
    const ev: AppendInput = existing
      ? {
          streamId: streamId.workflow(orgId, def.key),
          event: {
            type: 'WorkflowDraftUpdated',
            payload: { workflowVersionId: id, name: def.name, department: def.department, definition: def },
          },
          actor: actorOf(designer),
          scope: orgScope(orgId),
        }
      : {
          streamId: streamId.workflow(orgId, def.key),
          event: {
            type: 'WorkflowVersionRegistered',
            payload: {
              workflowVersionId: id,
              orgId,
              key: def.key,
              version,
              name: def.name,
              department: def.department,
              definition: def,
              status: 'draft',
              draftedBy: authorOf(designer),
            },
          },
          actor: actorOf(designer),
          scope: orgScope(orgId),
        };
    await ctx.store.append([ev], { tx });
    return { id, key: def.key, version, status: 'draft' as const, issues };
  });
}

// --------------------------------------------------------------------------- validate, submit, discard

export type DefinitionKind = 'role' | 'workflow';

async function loadVersion(db: Queryable, kind: DefinitionKind, orgId: string, id: string, lock = false) {
  const table = kind === 'role' ? 'role_definitions' : 'workflow_versions';
  const r = await one(db, `SELECT * FROM ${table} WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!r) throw notFound(`${kind} not found`);
  if (r.org_id === null)
    throw forbidden(`built-in ${kind}s ship with the app: they cannot be changed or removed`);
  if (r.org_id !== orgId) throw notFound(`${kind} not found`);
  return r;
}

async function issuesFor(db: Queryable, kind: DefinitionKind, row: Row, withDrafts: boolean) {
  const ctxs = await validationContexts(db, row.org_id);
  if (kind === 'role')
    return validateRoleDefinition(row.definition, ctxs.role).map((i): DefinitionIssue => ({ ...i }));
  return validateCustomWorkflow(
    row.definition,
    await roleCatalogue(db, row.org_id, withDrafts),
    ctxs.workflow,
  ).map(issueOfWorkflow);
}

export async function validateDraft(
  ctx: Ctx,
  orgId: string,
  kind: DefinitionKind,
  id: string,
): Promise<ValidateResponse> {
  const row = await loadVersion(ctx.pool, kind, orgId, id);
  const issues = await issuesFor(ctx.pool, kind, row, row.status === 'draft');
  return { id, valid: !issues.some((i) => i.severity === 'error'), issues };
}

const describeWorkflow = (def: WorkflowDefinition): string =>
  [
    `Workflow ${def.name} (${def.key} v${def.version})${def.department ? `, department ${def.department}` : ''}.`,
    ...def.stages.map(
      (s) =>
        `- ${s.label}: ${s.kind === 'agent' ? `claimed by ${s.claimRole}${s.seniorOnly ? ' (senior)' : ''}` : s.kind}${
          s.requiredFields.length ? `; needs ${s.requiredFields.join(', ')}` : ''
        }${s.outcomes.length ? `; outcomes ${s.outcomes.map((o) => `${o.id} -> ${o.to}`).join(', ')}` : ''}`,
    ),
  ].join('\n');

const describeRole = (def: RoleDefinition): string =>
  [
    `Role ${def.name} (${def.key} v${def.version})${def.department ? `, department ${def.department}` : ''}.`,
    def.purpose,
    `Seniority: ${def.seniorityLevels.join(', ')}. Model: ${def.defaultModel.runtime}/${def.defaultModel.model}.`,
    `Tools: ${def.permissions.allowedTools.join(', ') || 'none'}. May commit: ${def.permissions.mayCommit ? 'yes' : 'no'}.`,
    `May claim: ${def.claimableStages.map((c) => `${c.workflowKey}.${c.stageId}`).join(', ')}.`,
  ].join('\n');

/**
 * Validates the draft and puts it on the owner's desk for approval; only an approved definition becomes available.
 * A draft with errors cannot be submitted (the issues come back with the 422).
 */
export async function submitDraft(
  ctx: Ctx,
  designer: Designer,
  orgId: string,
  kind: DefinitionKind,
  id: string,
): Promise<SubmitResponse> {
  return withAppendTx(ctx.pool, async (tx) => {
    const row = await loadVersion(tx, kind, orgId, id, true);
    if (row.status !== 'draft') throw conflict('not_a_draft', `this ${kind} is ${row.status}, not a draft`);
    const issues = await issuesFor(tx, kind, row, true);
    if (issues.some((i) => i.severity === 'error')) {
      const first = issues.find((i) => i.severity === 'error') as DefinitionIssue;
      throw unprocessable('invalid_definition', `cannot submit: ${first.message}`, { issues });
    }
    const deskItemId = randomUUID();
    const def = row.definition as RoleDefinition & WorkflowDefinition;
    const n = def.version;
    await ctx.store.append(
      [
        {
          streamId: streamId.desk(deskItemId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId,
              kind: 'approval',
              subkind: DESK_SUBKIND_DEFINITION,
              title: `Approve ${kind} "${def.name}" (v${n})`,
              body: kind === 'role' ? describeRole(def) : describeWorkflow(def),
              options: [],
              blocking: false,
              pinned: false,
              affectedCardIds: [],
              askedBy:
                designer.kind === 'agent' ? { kind: 'agent', agentId: designer.agentId } : { kind: 'system' },
            },
          },
          actor: designer.kind === 'agent' ? agentActor(designer.agentId) : SYSTEM_ACTOR,
          scope: orgScope(orgId),
        },
        {
          streamId: kind === 'role' ? streamId.role(orgId, row.key) : streamId.workflow(orgId, row.key),
          event:
            kind === 'role'
              ? { type: 'RoleVersionSubmitted', payload: { roleVersionId: id, deskItemId } }
              : { type: 'WorkflowVersionSubmitted', payload: { workflowVersionId: id, deskItemId } },
          actor: actorOf(designer),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
    return { id, deskItemId, status: 'pending_approval' as const };
  });
}

/** Drops a draft (or a rejected definition) that was never approved; approved versions are never removed. */
export async function discardDraft(ctx: Ctx, orgId: string, kind: DefinitionKind, id: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const row = await loadVersion(tx, kind, orgId, id, true);
    if (row.status !== 'draft' && row.status !== 'rejected')
      throw conflict('not_discardable', `a ${row.status} ${kind} cannot be removed`);
    await ctx.store.append(
      [
        {
          streamId: kind === 'role' ? streamId.role(orgId, row.key) : streamId.workflow(orgId, row.key),
          event: { type: 'DefinitionDraftDiscarded', payload: { kind, versionId: id } },
          actor: userActor(orgId),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
}

/**
 * Desk resolution of a definition approval (inside the desk transaction). Only the owner reaches this (the item is
 * an org-level desk item). Approving validates once more against the catalogue as it is now: a workflow whose custom
 * role is not approved yet cannot become available.
 */
export async function resolveDefinitionIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string },
  item: Row,
  resolution: 'approved' | 'rejected' | 'acknowledged' | 'dismissed',
  _note?: string,
): Promise<void> {
  if (resolution === 'acknowledged')
    throw badRequest('wrong_resolution', 'a definition is approved or rejected');
  if (item.org_id !== user.id) throw forbidden('only the organization owner can approve definitions');
  const role = await one(tx, 'SELECT * FROM role_definitions WHERE desk_item_id=$1 FOR UPDATE', [item.id]);
  const wf = role
    ? undefined
    : await one(tx, 'SELECT * FROM workflow_versions WHERE desk_item_id=$1 FOR UPDATE', [item.id]);
  const row = role ?? wf;
  if (!row) throw notFound('definition not found');
  const kind: DefinitionKind = role ? 'role' : 'workflow';
  if (row.status !== 'pending_approval')
    throw conflict('already_decided', `this ${kind} is already ${row.status}`);
  const scope = orgScope(row.org_id);
  const stream =
    kind === 'role' ? streamId.role(row.org_id, row.key) : streamId.workflow(row.org_id, row.key);
  let event: AppendInput['event'];
  if (resolution === 'approved') {
    const issues = await issuesFor(tx, kind, row, false);
    if (issues.some((i) => i.severity === 'error')) {
      const first = issues.find((i) => i.severity === 'error') as DefinitionIssue;
      throw unprocessable(
        'invalid_definition',
        `cannot approve: ${first.message}${first.code === 'unknown_role' ? ' (approve the role first)' : ''}`,
        { issues },
      );
    }
    event =
      kind === 'role'
        ? { type: 'RoleVersionApproved', payload: { roleVersionId: row.id } }
        : { type: 'WorkflowVersionApproved', payload: { workflowVersionId: row.id } };
  } else {
    event =
      kind === 'role'
        ? { type: 'RoleVersionRejected', payload: { roleVersionId: row.id } }
        : { type: 'WorkflowVersionRejected', payload: { workflowVersionId: row.id } };
  }
  await ctx.store.append([{ streamId: stream, event, actor: userActor(user.id), scope }], { tx });
}

// ------------------------------------------------------------------------------------ extend built-ins

/** The owner's extra instructions, skills and standing orders for a built-in role. Core rules are not part of it. */
export async function extendRole(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  roleKey: string,
  req: ExtendRoleRequest,
): Promise<{ roleKey: string; baseVersion: number }> {
  if (orgId !== user.id) throw forbidden('only the organization owner can extend a role');
  if (!req.instructions.trim() && req.skills.length === 0 && req.standingOrders.length === 0)
    throw badRequest('empty_extension', 'add instructions, skills or standing orders (or reset the role)');
  return withAppendTx(ctx.pool, async (tx) => {
    const latest = await one<{ version: number }>(
      tx,
      `SELECT version FROM role_definitions WHERE org_id IS NULL AND key=$1 AND status='active'
        ORDER BY version DESC LIMIT 1`,
      [roleKey],
    );
    if (!latest)
      throw notFound('built-in role not found: custom roles are changed by drafting a new version');
    if (roleKey === 'devops') throw badRequest('not_extendable', 'the DevOps engineer cannot be extended');
    await ctx.store.append(
      [
        {
          streamId: streamId.role(orgId, roleKey),
          event: {
            type: 'RoleExtended',
            payload: {
              orgId,
              roleKey,
              baseVersion: latest.version,
              extensions: {
                instructions: req.instructions.trim(),
                skills: [...new Set(req.skills.map((s) => s.trim()))],
                standingOrders: req.standingOrders.map((s) => s.trim()),
              },
            },
          },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
    return { roleKey, baseVersion: latest.version };
  });
}

// ----------------------------------------------------------------------------------------- departments

export async function createDepartment(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  req: CreateDepartmentRequest,
): Promise<DepartmentDto> {
  if (orgId !== user.id) throw forbidden('only the organization owner can create departments');
  const name = req.name.trim();
  return withAppendTx(ctx.pool, async (tx) => {
    const taken = (await departmentNames(tx, orgId)).some((n) => n.toLowerCase() === name.toLowerCase());
    if (taken) throw conflict('department_exists', `the department '${name}' already exists`);
    const departmentId = randomUUID();
    await ctx.store.append(
      [
        {
          streamId: streamId.department(orgId),
          event: { type: 'DepartmentCreated', payload: { departmentId, orgId, name } },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
    return { id: departmentId, name, builtIn: false, roleKeys: [], workflowKeys: [] };
  });
}

// ----------------------------------------------------------------------------------------------- read

export async function orgCatalogue(
  ctx: Ctx,
  user: { id: string },
  projectId?: string,
): Promise<OrgCatalogueResponse> {
  const { orgId, isOwner } = await catalogueOrg(ctx.pool, user, projectId, false);
  const visible = isOwner
    ? `status IN ('draft','pending_approval','active','superseded','rejected')`
    : `status IN ('active','superseded')`;
  const roleRows = await rows(
    ctx.pool,
    `SELECT * FROM role_definitions WHERE (org_id IS NULL OR org_id = $1) AND ${visible}
      ORDER BY (org_id IS NULL) DESC, key, version DESC`,
    [orgId],
  );
  const wfRows = await rows(
    ctx.pool,
    `SELECT w.*, (SELECT count(*)::int FROM cards c WHERE c.workflow_version_id = w.id
                   AND c.status NOT IN ('done','cancelled')) AS in_flight
       FROM workflow_versions w WHERE (w.org_id IS NULL OR w.org_id = $1) AND ${visible.replaceAll('status', 'w.status')}
      ORDER BY (w.org_id IS NULL) DESC, w.key, w.version DESC`,
    [orgId],
  );
  const exts = await rows(ctx.pool, 'SELECT * FROM role_extensions WHERE org_id=$1', [orgId]);
  const roles = new Map<string, OrgCatalogueResponse['roles'][number]>();
  for (const r of roleRows) {
    const k = `${r.org_id ?? ''}/${r.key}`;
    let g = roles.get(k);
    if (!g) {
      const e = r.org_id === null ? exts.find((x) => x.role_key === r.key) : undefined;
      g = {
        key: r.key,
        builtIn: r.org_id === null,
        versions: [],
        extensions: e
          ? {
              baseVersion: e.base_version,
              instructions: e.extensions.instructions ?? '',
              skills: e.extensions.skills ?? [],
              standingOrders: e.extensions.standingOrders ?? [],
            }
          : null,
      };
      roles.set(k, g);
    }
    g.versions.push({
      id: r.id,
      version: r.version,
      status: r.status,
      deskItemId: r.desk_item_id,
      vaultPath: r.vault_path,
      draftedByAgent: r.drafted_by_kind === 'agent',
      createdAt: iso(r.created_at) as string,
      definition: RoleDefinitionSchema.parse(r.definition),
    });
  }
  const workflows = new Map<string, OrgCatalogueResponse['workflows'][number]>();
  for (const w of wfRows) {
    const k = `${w.org_id ?? ''}/${w.key}`;
    let g = workflows.get(k);
    if (!g) {
      g = { key: w.key, builtIn: w.org_id === null, versions: [] };
      workflows.set(k, g);
    }
    g.versions.push({
      id: w.id,
      version: w.version,
      status: w.status,
      deskItemId: w.desk_item_id,
      vaultPath: w.vault_path,
      draftedByAgent: w.drafted_by_kind === 'agent',
      createdAt: iso(w.created_at) as string,
      definition: WorkflowDefinitionSchema.parse(w.definition),
      cardsInFlight: Number(w.in_flight),
    });
  }
  return {
    orgId,
    canEdit: isOwner,
    roles: [...roles.values()],
    workflows: [...workflows.values()],
    departments: await listDepartments(ctx.pool, orgId),
  };
}

export async function listDepartments(db: Queryable, orgId: string): Promise<DepartmentDto[]> {
  const own = await rows<{ id: string; name: string }>(
    db,
    'SELECT id, name FROM departments WHERE org_id=$1 ORDER BY created_at',
    [orgId],
  );
  const roleKeys = await rows<{ key: string; department: string | null }>(
    db,
    `SELECT DISTINCT ON (key, org_id) key, department FROM role_definitions
      WHERE (org_id IS NULL OR org_id=$1) AND status='active' AND department IS NOT NULL
      ORDER BY key, org_id, version DESC`,
    [orgId],
  );
  const wfKeys = await rows<{ key: string; department: string | null }>(
    db,
    `SELECT DISTINCT ON (key, org_id) key, department FROM workflow_versions
      WHERE (org_id IS NULL OR org_id=$1) AND status='active' AND department IS NOT NULL
      ORDER BY key, org_id, version DESC`,
    [orgId],
  );
  const mk = (name: string, id: string | null, builtIn: boolean): DepartmentDto => ({
    id,
    name,
    builtIn,
    roleKeys: roleKeys.filter((r) => r.department === name).map((r) => r.key),
    workflowKeys: wfKeys.filter((w) => w.department === name).map((w) => w.key),
  });
  return [...BUILTIN_DEPARTMENTS.map((n) => mk(n, null, true)), ...own.map((d) => mk(d.name, d.id, false))];
}

/** The definition file as stored in the vault (for the Organization page and tests). */
export async function definitionFile(
  ctx: Ctx,
  user: { id: string },
  id: string,
  projectId?: string,
): Promise<{ path: string; content: string; format: string }> {
  const { orgId } = await catalogueOrg(ctx.pool, user, projectId, false);
  const role = await one(ctx.pool, 'SELECT * FROM role_definitions WHERE id=$1', [id]);
  const wf = role ? undefined : await one(ctx.pool, 'SELECT * FROM workflow_versions WHERE id=$1', [id]);
  const row = role ?? wf;
  if (!row || (row.org_id !== orgId && row.org_id !== null)) throw notFound('definition not found');
  const kind: DefinitionKind = role ? 'role' : 'workflow';
  return {
    path: definitionVaultPath(kind, row.key, row.version),
    format: DEFINITION_FORMAT,
    content:
      kind === 'role'
        ? renderDefinitionFile({ kind, definition: row.definition })
        : renderDefinitionFile({ kind, definition: row.definition }),
  };
}

// ------------------------------------------------------------------------------------------ vault copy

/**
 * An approved custom definition is written to the owner's vault as a provider-neutral YAML file (a durable
 * `vault.write`); the site keeps its own registered copy either way. With no vault registered nothing is written.
 */
export function registerDefinitionHook(ctx: Ctx): () => void {
  return ctx.store.subscribe(async (e: StoredEvent) => {
    try {
      const ev = e.event;
      let kind: DefinitionKind;
      let id: string;
      if (ev.type === 'RoleVersionApproved') {
        kind = 'role';
        id = ev.payload.roleVersionId;
      } else if (ev.type === 'WorkflowVersionApproved') {
        kind = 'workflow';
        id = ev.payload.workflowVersionId;
      } else return;
      const row = await one(
        ctx.pool,
        `SELECT * FROM ${kind === 'role' ? 'role_definitions' : 'workflow_versions'} WHERE id=$1`,
        [id],
      );
      if (!row || row.org_id === null) return;
      const vault = await one(
        ctx.pool,
        `SELECT id FROM vaults WHERE org_id=$1 AND project_id IS NULL ORDER BY (kind='work') DESC, created_at LIMIT 1`,
        [row.org_id],
      );
      if (!vault) return;
      const path = definitionVaultPath(kind, row.key, row.version);
      const content =
        kind === 'role'
          ? renderDefinitionFile({ kind, definition: row.definition, approvedAt: e.createdAt })
          : renderDefinitionFile({ kind, definition: row.definition, approvedAt: e.createdAt });
      const r = await enqueueVaultWrite(ctx, ctx.pool, vault.id, {
        path,
        mode: 'replace',
        content,
        commitMessage: `aom: ${kind} ${row.key} v${row.version}`,
      });
      if (r.queued && r.workstationId) await ctx.services.gateway.deliverPending(r.workstationId);
    } catch (err) {
      ctx.log.warn({ err }, 'definition vault write hook failed');
    }
  });
}
