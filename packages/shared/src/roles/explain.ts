/** A role issue as the validator or the API reports it (the API's code is a plain string). */
export interface RoleIssueLike {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  field?: string | undefined;
}

/**
 * Owner-friendly wording for role validation issues (docs/design/workflow-builder.md section 3): each code maps to a
 * plain sentence and the section of the role builder it belongs to. The validator's own `message` stays for logs, the
 * API and the advanced panel.
 */
export type RoleSection = 'basics' | 'instructions' | 'model' | 'seniority' | 'permissions' | 'steps';

export interface ExplainedRoleIssue {
  severity: RoleIssueLike['severity'];
  code: string;
  text: string;
  section: RoleSection;
  issue: RoleIssueLike;
}

/** The text between the first pair of single quotes of a validator message, or ''. */
const quoted = (m: string): string => /'([^']*)'/.exec(m)?.[1] ?? '';

const FIELD_SECTION: Record<string, RoleSection> = {
  key: 'basics',
  name: 'basics',
  purpose: 'basics',
  department: 'basics',
  instructions: 'instructions',
  coreRules: 'instructions',
  skills: 'instructions',
  seniorityLevels: 'seniority',
  defaultModel: 'model',
  permissions: 'permissions',
  claimableStages: 'steps',
};

export function explainRoleIssue(issue: RoleIssueLike): ExplainedRoleIssue {
  const q = quoted(issue.message);
  const field = issue.field ?? '';
  const section = FIELD_SECTION[field] ?? 'basics';
  const at = (text: string, s: RoleSection = section): ExplainedRoleIssue => ({
    severity: issue.severity,
    code: issue.code,
    text,
    section: s,
    issue,
  });
  switch (issue.code) {
    case 'invalid_schema':
      if (field === 'name') return at('Give the role a name.', 'basics');
      if (field === 'key')
        return at(
          'The short name (key) may only use lowercase letters, digits, - and _, and must start with a letter.',
          'basics',
        );
      if (field === 'seniorityLevels') return at('Pick at least one seniority level.', 'seniority');
      return at(`Something in this role is not filled in correctly (${issue.message}).`);
    case 'builtin_key':
      return at(
        `"${q}" is the short name of a built-in role. Pick another short name so yours does not clash.`,
        'basics',
      );
    case 'not_custom':
      return at('A custom role cannot be marked as built in.', 'basics');
    case 'no_instructions':
      return at('Tell the role how to do its work: the instructions are empty.', 'instructions');
    case 'no_claimable_stages':
      return at(
        'Pick at least one step this role can take, otherwise nobody will ever give it work. Create a custom workflow first if the list is empty.',
        'steps',
      );
    case 'claims_builtin_workflow':
      return at(
        `"${q}" is a built-in workflow. Custom roles take steps of your own custom workflows; built-in workflows name built-in roles.`,
        'steps',
      );
    case 'wildcard_workflow':
      return at('Choose which workflow this role takes steps from.', 'steps');
    case 'unknown_tool':
      return at(
        `"${q}" is not a tool the role can use. Use the switches under "What it may do" instead.`,
        'permissions',
      );
    case 'unknown_department':
      return at(`The department "${q}" does not exist yet. Create it first, or pick another.`, 'basics');
    case 'reads_org_repos':
      return at(
        'This role can read every repository of the organization on the workstation (read only). Only switch this on when the role needs it; the Owner approves it.',
        'permissions',
      );
    default:
      return at(issue.message);
  }
}

export const explainRoleIssues = (issues: readonly RoleIssueLike[]): ExplainedRoleIssue[] =>
  issues.map(explainRoleIssue);
