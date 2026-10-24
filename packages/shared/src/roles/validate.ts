import { type RoleDefinition, RoleDefinitionSchema } from './schema.ts';

export type RoleIssueCode =
  | 'invalid_schema'
  | 'builtin_key'
  | 'not_custom'
  | 'no_instructions'
  | 'no_claimable_stages'
  | 'claims_builtin_workflow'
  | 'wildcard_workflow'
  | 'unknown_tool'
  | 'unknown_department'
  | 'reads_org_repos';

export interface RoleIssue {
  severity: 'error' | 'warning';
  code: RoleIssueCode;
  message: string;
  field?: string;
}

export interface RoleValidationContext {
  builtinRoleKeys: readonly string[];
  builtinWorkflowKeys: readonly string[];
  /** Department names that exist (built-in departments and the owner's). */
  departments: readonly string[];
}

const TOOL = /^(read|edit|shell|web|mcp:[A-Za-z0-9_.-]+)$/;

/**
 * Validates a custom role definition before it is drafted or submitted. Custom roles never shadow a built-in key and
 * only claim stages of the owner's own (custom) workflows: the built-in workflows name built-in roles.
 */
export function validateRoleDefinition(input: unknown, ctx: RoleValidationContext): RoleIssue[] {
  const parsed = RoleDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({
      severity: 'error' as const,
      code: 'invalid_schema' as const,
      message: `${i.path.join('.') || '(root)'}: ${i.message}`,
      field: String(i.path[0] ?? ''),
    }));
  }
  const def: RoleDefinition = parsed.data;
  const issues: RoleIssue[] = [];
  const err = (code: RoleIssueCode, message: string, field?: string) =>
    issues.push({ severity: 'error', code, message, field });
  const warn = (code: RoleIssueCode, message: string, field?: string) =>
    issues.push({ severity: 'warning', code, message, field });
  if (def.builtIn) err('not_custom', 'a custom role cannot be marked built-in', 'builtIn');
  if (ctx.builtinRoleKeys.includes(def.key))
    err('builtin_key', `'${def.key}' is a built-in role: pick another key`, 'key');
  if (!def.name.trim()) err('invalid_schema', 'the role needs a name', 'name');
  if (!def.instructions.trim()) err('no_instructions', 'the role needs instructions', 'instructions');
  // a role made from a pack persona is for chats and sessions: it claims no workflow stage
  if (def.claimableStages.length === 0 && !def.source)
    err(
      'no_claimable_stages',
      'the role must be able to claim at least one workflow stage',
      'claimableStages',
    );
  for (const c of def.claimableStages) {
    if (c.workflowKey === '*')
      err('wildcard_workflow', 'name the workflow the role may claim stages of', 'claimableStages');
    else if (ctx.builtinWorkflowKeys.includes(c.workflowKey))
      err(
        'claims_builtin_workflow',
        `'${c.workflowKey}' is a built-in workflow: custom roles claim stages of custom workflows`,
        'claimableStages',
      );
  }
  for (const t of def.permissions.allowedTools)
    if (!TOOL.test(t))
      err('unknown_tool', `unknown tool '${t}' (read, edit, shell, web or mcp:<name>)`, 'permissions');
  if (def.permissions.readOrgRepos)
    warn(
      'reads_org_repos',
      'this role can read every repository of the organization on the workstation (read-only)',
      'permissions',
    );
  if (def.department && !ctx.departments.includes(def.department))
    err('unknown_department', `department '${def.department}' does not exist: create it first`, 'department');
  return issues;
}
