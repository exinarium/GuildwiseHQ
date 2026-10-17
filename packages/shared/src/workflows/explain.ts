import type { WorkflowDefinitionInput } from './schema.ts';
import type { IssueCode, ValidationIssue } from './validate.ts';

/**
 * Owner-friendly wording for validation issues (docs/design/workflow-builder.md 2.3). The validator's own `message`
 * is for logs and the API; this maps each `IssueCode` to a plain sentence and the step/field the builder pins it on.
 */

/** The part of a step (or the workflow) an issue is about, as the builder names its inputs. */
export type ExplainField =
  | 'label'
  | 'kind'
  | 'role'
  | 'seniorOnly'
  | 'outcomes'
  | 'route'
  | 'requiredFields'
  | 'when'
  | 'doneCriteria'
  | 'subworkflow'
  | 'steps'
  | 'details';

export interface ExplainedIssue {
  severity: ValidationIssue['severity'];
  code: IssueCode;
  /** One plain sentence, ready to show. */
  text: string;
  /** Step to pin it on; absent: the workflow as a whole. */
  stageId?: string;
  outcomeId?: string;
  field: ExplainField;
  /** The original issue (the advanced panel shows its technical message). */
  issue: ValidationIssue;
}

type Stages = Pick<WorkflowDefinitionInput, 'stages'>;

/** Text between the n-th pair of single quotes of a validator message ("stage 'x' ... role 'y'"), or ''. */
function quoted(message: string, n: number): string {
  const all = [...message.matchAll(/'([^']*)'/g)];
  return all[n]?.[1] ?? '';
}

interface Spec {
  field: ExplainField;
  text: (c: { step: string; issue: ValidationIssue; q: (n: number) => string; outcome: string }) => string;
}

const SPEC: Record<IssueCode, Spec> = {
  invalid_schema: {
    field: 'details',
    text: ({ issue }) => `Something in the workflow is not filled in correctly (${issue.message}).`,
  },
  duplicate_stage_id: {
    field: 'label',
    text: ({ step }) => `${step} shares its name with another step. Give each step its own name.`,
  },
  duplicate_outcome_id: {
    field: 'route',
    text: ({ step }) => `${step} has two routes with the same name. Rename one of them.`,
  },
  missing_initial_stage: {
    field: 'steps',
    text: () => 'The workflow does not say where a new card starts. Make one step the first step.',
  },
  no_terminal_stage: {
    field: 'steps',
    text: () => 'The workflow has no final step. Add a "Finished" step at the end.',
  },
  terminal_has_outcomes: {
    field: 'route',
    text: ({ step }) => `${step} is a final step, so nothing can follow it. Remove its routes.`,
  },
  no_outcomes: {
    field: 'route',
    text: ({ step }) => `${step} does not say where the card goes when it is finished. Choose the next step.`,
  },
  no_success_outcome: {
    field: 'route',
    text: ({ step }) => `${step} has no "when finished, go to" route. Choose the next step.`,
  },
  outcome_guard_gap: {
    field: 'route',
    text: ({ step }) =>
      `${step} has conditional routes that leave some cards with nowhere to go. Add a route that applies in every case.`,
  },
  agent_stage_without_role: {
    field: 'role',
    text: ({ step }) => `${step} has no role that may work it. Pick a role or create one.`,
  },
  unknown_role: {
    field: 'role',
    text: ({ step, q }) =>
      `${step} names a role that does not exist${q(1) ? ` ('${q(1)}')` : ''}. Pick another role or create it.`,
  },
  role_cannot_claim_stage: {
    field: 'role',
    text: ({ step, q }) =>
      `The role ${q(0) ? `'${q(0)}' ` : ''}is not allowed to take ${step}. Add this step to the role's steps, or pick another role.`,
  },
  role_not_senior: {
    field: 'seniorOnly',
    text: ({ step }) =>
      `${step} is for senior staff only, but the chosen role has no senior level. Pick another role or turn the setting off.`,
  },
  unknown_outcome_target: {
    field: 'route',
    text: ({ step, outcome }) =>
      `${outcome ? `The route "${outcome}" of ` : 'A route of '}${step} leads to a step that no longer exists. Pick another step.`,
  },
  unreachable_stage: {
    field: 'steps',
    text: ({ step }) => `${step} can never be reached. Route a step to it, or remove it.`,
  },
  no_path_to_terminal: {
    field: 'route',
    text: ({ step }) => `A card at ${step} can never finish. Make sure its routes lead to the final step.`,
  },
  failure_no_path_to_terminal: {
    field: 'route',
    text: ({ step, outcome }) =>
      `Sending a card back from ${step}${outcome ? ` ("${outcome}")` : ''} leads somewhere that can never finish. Check where it goes.`,
  },
  unknown_required_field: {
    field: 'requiredFields',
    text: ({ step, q }) =>
      `${step} needs information${q(1) ? ` ('${q(1)}')` : ''} that the card does not carry. Add that field to the card or remove the requirement.`,
  },
  invalid_effect: {
    field: 'route',
    text: ({ step }) =>
      `A route of ${step} uses behaviour that is not available here. Use a plain route instead.`,
  },
  when_field_not_boolean: {
    field: 'when',
    text: ({ step }) => `The "only when" condition of ${step} must use a yes/no field. Pick a yes/no field.`,
  },
  not_custom: { field: 'details', text: () => 'A custom workflow cannot be marked as built in.' },
  invalid_key: {
    field: 'details',
    text: () => 'The workflow key may only use lowercase letters, digits, "-" and "_".',
  },
  builtin_key: {
    field: 'details',
    text: ({ q }) => `The key${q(0) ? ` '${q(0)}'` : ''} belongs to a built-in workflow. Pick another key.`,
  },
  invalid_field_set: {
    field: 'details',
    text: () => 'Custom workflows carry their own card fields. Reset the field set to "custom".',
  },
  invalid_card_type: {
    field: 'details',
    text: ({ issue }) => `The card types of this workflow are not valid (${issue.message}).`,
  },
  unknown_department: {
    field: 'details',
    text: () => 'The department does not exist. Pick another one or create it first.',
  },
  manual_stage_not_initial: {
    field: 'kind',
    text: ({ step }) =>
      `${step} is a "starts here" step, which only the first step can be. Make it an agent step.`,
  },
  role_not_claimable: {
    field: 'role',
    text: ({ step }) => `The chosen role cannot take part in workflows (${step}). Pick another role.`,
  },
  unsupported_custom_event: {
    field: 'route',
    text: ({ step }) =>
      `A route of ${step} uses special behaviour that custom workflows do not have. Use a plain route instead.`,
  },
  variant_base_not_allowed: {
    field: 'details',
    text: () => 'This built-in workflow cannot be extended for a project.',
  },
  variant_base_mismatch: {
    field: 'details',
    text: () =>
      'The project workflow was based on a different version of the built-in workflow. Start again from the current one.',
  },
  variant_invalid_insertion: {
    field: 'steps',
    text: ({ issue }) => `A step cannot be inserted there (${issue.message}).`,
  },
  variant_definition_mismatch: {
    field: 'details',
    text: () => 'The saved workflow no longer matches its built-in base. Start again from the current one.',
  },
  subworkflow_missing_config: {
    field: 'subworkflow',
    text: ({ step }) =>
      `${step} starts another workflow but does not say which. Choose the workflow to start.`,
  },
  subworkflow_config_misplaced: {
    field: 'kind',
    text: ({ step }) =>
      `${step} has sub-workflow settings but is not a sub-workflow step. Change its type or clear the settings.`,
  },
  subworkflow_has_role: {
    field: 'role',
    text: ({ step }) => `${step} runs by itself, so it takes no role. Clear the role.`,
  },
  subworkflow_no_failed_route: {
    field: 'route',
    text: ({ step }) =>
      `${step} waits for another workflow but has no route for when that work is cancelled. Choose where the card goes then.`,
  },
  subworkflow_duplicate_mapping: {
    field: 'subworkflow',
    text: ({ step, q }) =>
      `${step} fills the field${q(1) ? ` '${q(1)}'` : ''} of the new card twice. Keep one.`,
  },
  subworkflow_unknown_field: {
    field: 'subworkflow',
    text: ({ step, q }) =>
      `${step} uses a field${q(1) ? ` ('${q(1)}')` : ''} that does not exist. Pick an existing field.`,
  },
  subworkflow_field_out_in_continue: {
    field: 'subworkflow',
    text: ({ step }) =>
      `${step} carries on without waiting, so it cannot copy results back. Switch to "wait", or remove the copy-back fields.`,
  },
  subworkflow_unknown_target: {
    field: 'subworkflow',
    text: ({ step, q }) =>
      `${step} starts a workflow that does not exist${q(1) ? ` ('${q(1)}')` : ''}. Pick another workflow.`,
  },
  subworkflow_target_not_approved: {
    field: 'subworkflow',
    text: ({ step }) => `The workflow ${step} starts has not been approved yet. Get it approved first.`,
  },
  subworkflow_target_not_enabled: {
    field: 'subworkflow',
    text: ({ step }) =>
      `The workflow ${step} starts is not switched on in that project. Enable it there first.`,
  },
  subworkflow_cross_org: {
    field: 'subworkflow',
    text: ({ step }) => `${step} points at a project in another organisation, which is not allowed.`,
  },
  subworkflow_cycle: {
    field: 'subworkflow',
    text: ({ step }) =>
      `${step} would start a workflow that ends up starting this one again. Break the loop.`,
  },
  subworkflow_too_deep: {
    field: 'steps',
    text: () => 'Workflows start workflows too many levels deep (at most 3). Flatten them.',
  },
  subworkflow_unknown_card_type: {
    field: 'subworkflow',
    text: ({ step }) =>
      `The other workflow does not handle the card type ${step} asks for. Pick one it supports.`,
  },
  subworkflow_field_type: {
    field: 'subworkflow',
    text: ({ step }) =>
      `${step} copies information into a field of a different kind (for example text into a yes/no field). Pick a matching field.`,
  },
  subworkflow_required_unmapped: {
    field: 'subworkflow',
    text: ({ step }) =>
      `${step} starts the new card straight away but leaves required information empty. Fill it in, or start the card as a draft.`,
  },
  human_missing_config: {
    field: 'kind',
    text: ({ step }) => `${step} is a step for a person but does not say what kind. This is a built-in step.`,
  },
  human_config_misplaced: {
    field: 'kind',
    text: ({ step }) => `${step} carries settings for a person's step but is not one.`,
  },
  human_has_role: {
    field: 'role',
    text: ({ step }) => `${step} is done by a person, so it takes no role.`,
  },
  fallback_role_misplaced: {
    field: 'role',
    text: ({ step }) => `${step} has a fallback role but is not an agent step.`,
  },
  unknown_fallback_role: {
    field: 'role',
    text: ({ step }) => `${step} names a fallback role that does not exist. Pick another role.`,
  },
  environment_misplaced: {
    field: 'kind',
    text: ({ step }) => `${step} is not an agent step, so it cannot need a running environment.`,
  },
  environment_role_no_shell: {
    field: 'role',
    text: ({ step }) =>
      `${step} needs a running environment, but the role chosen for it cannot run commands to test it. Pick a role with a shell, such as the tester.`,
  },
  server_missing_config: {
    field: 'kind',
    text: ({ step }) => `${step} is a step the server runs but does not say which. This is a built-in step.`,
  },
  server_config_misplaced: {
    field: 'kind',
    text: ({ step }) => `${step} carries settings for a server step but is not one.`,
  },
  server_has_role: {
    field: 'role',
    text: ({ step }) => `${step} is run by the server, so it takes no role.`,
  },
  env_strict_misplaced: {
    field: 'kind',
    text: ({ step }) =>
      `${step} is set to start only on a prepared environment but does not use an environment.`,
  },
  evidence_misplaced: {
    field: 'kind',
    text: ({ step }) => `${step} asks for build evidence but is not an agent step.`,
  },
  approval_missing_approver: {
    field: 'role',
    text: ({ step }) => `${step} waits for an approval but does not say who approves. Choose the approver.`,
  },
  approver_misplaced: {
    field: 'role',
    text: ({ step }) => `${step} names an approver but is not an approval step.`,
  },
  human_outcomes: {
    field: 'route',
    text: ({ step, issue }) =>
      `${step} is a step for a person with fixed results (${issue.message}). Use the routes it offers.`,
  },
  approval_send_back_target: {
    field: 'route',
    text: ({ step }) =>
      `${step} sends the card back to a step that does not lead to it. Pick an earlier agent step to send it back to.`,
  },
  missing_done_criteria: {
    field: 'doneCriteria',
    text: ({ step }) =>
      `${step} does not say what "done" looks like. Describe it so the work can be checked.`,
  },
  too_many_stages: {
    field: 'steps',
    text: () => 'This workflow has a lot of steps. Consider splitting it in two.',
  },
};

/** Step name for sentences: "Step 'Check'" (label when known, else the id); '' text for workflow-level issues. */
function stepName(def: Stages | undefined, stageId: string | undefined): string {
  if (!stageId) return 'The workflow';
  const label = def?.stages.find((s) => s.id === stageId)?.label;
  return `Step '${label?.trim() || stageId}'`;
}

export function explainIssue(issue: ValidationIssue, def?: Stages): ExplainedIssue {
  const spec = SPEC[issue.code];
  const outcomeLabel = (() => {
    if (!issue.outcomeId || !issue.stageId) return '';
    const o = def?.stages
      .find((s) => s.id === issue.stageId)
      ?.outcomes?.find((x) => x.id === issue.outcomeId);
    return o?.label ?? issue.outcomeId;
  })();
  if (!spec) {
    return {
      severity: issue.severity,
      code: issue.code,
      text: issue.message,
      stageId: issue.stageId,
      outcomeId: issue.outcomeId,
      field: 'details',
      issue,
    };
  }
  return {
    severity: issue.severity,
    code: issue.code,
    text: spec.text({
      step: stepName(def, issue.stageId),
      issue,
      q: (n) => quoted(issue.message, n),
      outcome: outcomeLabel,
    }),
    stageId: issue.stageId,
    outcomeId: issue.outcomeId,
    field: spec.field,
    issue,
  };
}

export function explainIssues(issues: readonly ValidationIssue[], def?: Stages): ExplainedIssue[] {
  return issues.map((i) => explainIssue(i, def));
}

/** Groups explained issues by step id; workflow-level issues are under the empty string. Errors first. */
export function groupByStep(explained: readonly ExplainedIssue[]): Map<string, ExplainedIssue[]> {
  const out = new Map<string, ExplainedIssue[]>();
  for (const e of explained) {
    const key = e.stageId ?? '';
    out.set(key, [...(out.get(key) ?? []), e]);
  }
  for (const list of out.values())
    list.sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'));
  return out;
}

/** Every issue code the validator can emit has wording (tests assert it). */
export const EXPLAINED_CODES: readonly IssueCode[] = Object.keys(SPEC) as IssueCode[];
