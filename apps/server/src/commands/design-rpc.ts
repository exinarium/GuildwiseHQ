import {
  CreateDepartmentRequestSchema,
  type DefinitionIssue,
  isOrgManager,
  RoleDraftInputSchema,
  WorkflowDraftInputSchema,
  WorkflowVariantSpecSchema,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import { HttpError } from '../errors.ts';
import {
  createDepartment,
  type DefinitionKind,
  orgCatalogue,
  saveRoleDraft,
  saveWorkflowDraft,
  submitDraft,
  validateDraft,
} from './designer.ts';
import type { RpcReply } from './intake.ts';
import { saveVariantDraft } from './workflow-variants.ts';

const BA_ROLE_KEY = 'ba';

const fmtIssues = (issues: DefinitionIssue[]): string =>
  issues.length === 0
    ? 'No issues.'
    : issues
        .map(
          (i) =>
            `- ${i.severity}${i.stageId ? ` [stage ${i.stageId}${i.outcomeId ? `.${i.outcomeId}` : ''}]` : ''}: ${i.message} (${i.code})`,
        )
        .join('\n');

const errText = (err: unknown): string => {
  if (err instanceof HttpError) {
    const issues = (err.details as { issues?: DefinitionIssue[] } | undefined)?.issues;
    return issues?.length ? `${err.message}\n${fmtIssues(issues)}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
};

/** The organization the BA designs for: the Owner or Admin who is chatting with the BA (nobody else changes it). */
async function designerOf(
  ctx: Ctx,
  shift: Row,
): Promise<{ agentId: string; orgId: string; userId: string } | string> {
  if (shift.kind !== 'chat')
    return 'organization design happens in a chat with the business analyst, not in a card shift';
  const agent = await one(ctx.pool, 'SELECT id, org_id, role_key FROM agents WHERE id=$1', [shift.agent_id]);
  if (!agent || agent.role_key !== BA_ROLE_KEY)
    return 'only the business analyst designs roles and workflows';
  const chatUser = ctx.services.chat.userOfChat(shift.id);
  if (!chatUser || !isOrgManager({ orgRole: await orgRoleOf(ctx.pool, chatUser, agent.org_id) }))
    return 'only the organization Owner and Admins can design its roles and workflows: ask one of them to chat with the BA';
  return { agentId: agent.id, orgId: agent.org_id, userId: chatUser };
}

async function findDraft(
  ctx: Ctx,
  orgId: string,
  params: Record<string, unknown>,
): Promise<{ kind: DefinitionKind; id: string } | string> {
  const key = typeof params.key === 'string' ? params.key : '';
  if (!key) return 'name the role or workflow key';
  const want = params.kind === 'role' || params.kind === 'workflow' ? params.kind : undefined;
  const found: Array<{ kind: DefinitionKind; id: string }> = [];
  if (want !== 'workflow') {
    const r = await one(
      ctx.pool,
      `SELECT id FROM role_definitions WHERE org_id=$1 AND key=$2 AND status='draft' ORDER BY version DESC LIMIT 1`,
      [orgId, key],
    );
    if (r) found.push({ kind: 'role', id: r.id });
  }
  if (want !== 'role') {
    const w = await one(
      ctx.pool,
      `SELECT id FROM workflow_versions WHERE org_id=$1 AND key=$2 AND status='draft' ORDER BY version DESC LIMIT 1`,
      [orgId, key],
    );
    if (w) found.push({ kind: 'workflow', id: w.id });
  }
  if (found.length === 0) return `there is no open draft with the key '${key}'`;
  if (found.length > 1) return `both a role and a workflow are drafted as '${key}': say --role or --workflow`;
  return found[0] as { kind: DefinitionKind; id: string };
}

/**
 * `org.catalogue`, `org.role.draft`, `org.workflow.draft`, `org.validate`, `org.submit`, `org.department`: the BA's
 * design chat (docs/SPEC.md "Designing with the BA"). The BA drafts, the server validates, and a submitted
 * definition lands on the owner's desk: nothing is available before the owner approves it.
 */
export async function designRpc(
  ctx: Ctx,
  shift: Row,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  const who = await designerOf(ctx, shift);
  if (typeof who === 'string') return [false, undefined, who];
  const designer = { kind: 'agent', agentId: who.agentId } as const;
  try {
    switch (method) {
      case 'org.catalogue': {
        const c = await orgCatalogue(ctx, { id: who.userId }, who.orgId);
        const lines = [
          'Roles:',
          ...c.roles.map(
            (r) =>
              `- ${r.key}${r.builtIn ? ' (built in)' : ''}: ${r.versions.map((v) => `v${v.version} ${v.status}`).join(', ')}${r.versions[0]?.definition.department ? ` [${r.versions[0].definition.department}]` : ''}`,
          ),
          'Workflows:',
          ...c.workflows.map(
            (w) =>
              `- ${w.key}${w.builtIn ? ' (built in)' : ''}: ${w.versions.map((v) => `v${v.version} ${v.status}`).join(', ')}`,
          ),
          `Departments: ${c.departments.map((d) => d.name).join(', ')}`,
        ];
        return [true, { message: lines.join('\n') }];
      }
      case 'org.role.draft': {
        const input = RoleDraftInputSchema.safeParse(params.definition ?? params);
        if (!input.success)
          return [
            false,
            undefined,
            `the role draft is not valid: ${input.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          ];
        const r = await saveRoleDraft(ctx, designer, who.orgId, input.data, { upsert: true });
        return [
          true,
          {
            id: r.id,
            message: `Saved role draft ${r.key} v${r.version}.\n${fmtIssues(r.issues)}\n${r.issues.some((i) => i.severity === 'error') ? 'Fix the errors and draft it again, then submit.' : `Run \`aom org submit ${r.key} --role\` when the manager is happy with it.`}`,
          },
        ];
      }
      case 'org.workflow.draft': {
        const input = WorkflowDraftInputSchema.safeParse(params.definition ?? params);
        if (!input.success)
          return [
            false,
            undefined,
            `the workflow draft is not valid: ${input.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          ];
        const r = await saveWorkflowDraft(ctx, designer, who.orgId, input.data, { upsert: true });
        return [
          true,
          {
            id: r.id,
            message: `Saved workflow draft ${r.key} v${r.version}.\n${fmtIssues(r.issues)}\n${r.issues.some((i) => i.severity === 'error') ? 'Fix the errors and draft it again, then submit.' : `Run \`aom org submit ${r.key} --workflow\` when the manager is happy with it.`}`,
          },
        ];
      }
      case 'org.workflowVariant': {
        const raw = { ...((params.definition ?? params) as Record<string, unknown>) };
        // `project` (a key) may stand in for `projectId`.
        if (!raw.projectId && typeof raw.project === 'string') {
          const pr = await one(ctx.pool, 'SELECT id FROM projects WHERE org_id=$1 AND key=$2', [
            who.orgId,
            raw.project.toUpperCase(),
          ]);
          if (!pr) return [false, undefined, `there is no project '${raw.project}' in this organization`];
          raw.projectId = pr.id;
        }
        delete raw.project;
        const input = WorkflowVariantSpecSchema.safeParse(raw);
        if (!input.success)
          return [
            false,
            undefined,
            `the variant is not valid: ${input.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          ];
        const r = await saveVariantDraft(ctx, designer, who.orgId, input.data, { upsert: true });
        return [
          true,
          {
            id: r.id,
            message: `Saved variant draft ${r.key} v${r.version} (${r.stages.map((s) => s.id).join(' > ')}).\n${fmtIssues(r.issues)}\n${r.issues.some((i) => i.severity === 'error') ? 'Fix the errors and draft it again, then submit.' : `Run \`aom org submit ${r.key} --workflow\` when the manager is happy with it. After the owner approves, an Owner or Admin enables it in the project settings.`}`,
          },
        ];
      }
      case 'org.validate': {
        const d = await findDraft(ctx, who.orgId, params);
        if (typeof d === 'string') return [false, undefined, d];
        const v = await validateDraft(ctx, who.orgId, d.kind, d.id);
        return [
          true,
          { valid: v.valid, message: `${v.valid ? 'Valid.' : 'Not valid yet.'}\n${fmtIssues(v.issues)}` },
        ];
      }
      case 'org.submit': {
        const d = await findDraft(ctx, who.orgId, params);
        if (typeof d === 'string') return [false, undefined, d];
        const r = await submitDraft(ctx, designer, who.orgId, d.kind, d.id);
        return [
          true,
          {
            deskItemId: r.deskItemId,
            message: `Submitted. It is on the manager's desk for approval and is not available until they approve it.`,
          },
        ];
      }
      case 'org.department': {
        const p = CreateDepartmentRequestSchema.safeParse({ name: params.name });
        if (!p.success) return [false, undefined, 'usage: aom org department --name "<name>"'];
        const d = await createDepartment(ctx, { id: who.userId } as never, who.orgId, p.data);
        return [true, { message: `Department '${d.name}' created.` }];
      }
      default:
        return [false, undefined, `${method} is not available`];
    }
  } catch (err) {
    return [false, undefined, errText(err)];
  }
}
