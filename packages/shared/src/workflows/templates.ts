import { CARD_COLUMN_FIELDS, type FieldKind, fieldCatalogue } from '../cards/fields.ts';
import { CardType } from '../cards/types.ts';
import type { CustomField, Outcome, WorkflowDefinition, WorkflowDefinitionInput } from './schema.ts';

/**
 * Starting points for the workflow builder (docs/design/workflow-builder.md D5). Static data: nothing is stored.
 * Template agent steps carry `claimRole: null` and a `roleHints` entry; the builder asks the owner to pick or create
 * the role, so a fresh template fails validation with "pick a role" until then.
 */

export interface WorkflowTemplate {
  id: string;
  name: string;
  /** One line for the gallery card. */
  description: string;
  /** Step id -> what kind of role fits ("Writer"), for the role picker. */
  roleHints: Record<string, string>;
  definition: WorkflowDefinitionInput;
}

interface StepSpec {
  id: string;
  label: string;
  /** 'start' = manual first step (the owner or BA specifies the card). */
  kind: 'start' | 'agent' | 'end';
  done?: string;
  next?: string;
  /** Failure route ("if it is not good enough, send back to"). */
  back?: string;
  required?: string[];
  roleHint?: string;
}

type OutcomeInput = NonNullable<WorkflowDefinitionInput['stages'][number]['outcomes']>[number];

function outcome(
  id: string,
  label: string,
  kind: Outcome['kind'],
  to: string,
  extra: Partial<Pick<Outcome, 'event' | 'rework'>> = {},
): OutcomeInput {
  return {
    id,
    label,
    kind,
    to,
    event: extra.event ?? 'StageCompleted',
    data: 'none',
    rework: extra.rework ?? false,
    effect: 'none',
  };
}

function build(
  id: string,
  name: string,
  description: string,
  cardType: 'feature' | 'support' | 'docs',
  customFields: CustomField[],
  steps: StepSpec[],
): WorkflowTemplate {
  const roleHints: Record<string, string> = {};
  const stages = steps.map((s) => {
    if (s.roleHint) roleHints[s.id] = s.roleHint;
    const outcomes: OutcomeInput[] = [];
    if (s.kind !== 'end' && s.next)
      outcomes.push(
        outcome(
          s.kind === 'start' ? 'specified' : 'done',
          s.kind === 'start' ? 'Ready to start' : 'Finished',
          'success',
          s.next,
          {
            event: s.kind === 'start' ? 'CardSpecified' : 'StageCompleted',
          },
        ),
      );
    if (s.back) outcomes.push(outcome('rework', 'Not good enough', 'failure', s.back, { rework: true }));
    return {
      id: s.id,
      label: s.label,
      column: s.label,
      kind:
        s.kind === 'start'
          ? ('manual' as const)
          : s.kind === 'end'
            ? ('terminal' as const)
            : ('agent' as const),
      claimRole: null,
      doneCriteria: s.done ?? '',
      requiredFields: s.required ?? [],
      outcomes,
    };
  });
  return {
    id,
    name,
    description,
    roleHints,
    definition: {
      key: id,
      version: 1,
      name,
      builtIn: false,
      fieldSet: 'custom',
      customFields,
      cardTypes: [cardType],
      initialStage: steps[0]?.id ?? 'start',
      stages,
    },
  };
}

const textField = (key: string, label: string, required = false): CustomField => ({
  key,
  label,
  type: 'text',
  required,
});

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  build(
    'blank',
    'Blank',
    'One step of work between a start and a finish. Add the rest yourself.',
    'feature',
    [],
    [
      {
        id: 'request',
        label: 'Request',
        kind: 'start',
        next: 'work',
        done: 'The request is clear enough to start.',
      },
      {
        id: 'work',
        label: 'Work',
        kind: 'agent',
        next: 'finished',
        done: 'The work is complete.',
        roleHint: 'Worker',
      },
      { id: 'finished', label: 'Finished', kind: 'end' },
    ],
  ),
  build(
    'simple-review',
    'Simple review',
    'Someone does the work, someone else reviews it and can send it back.',
    'feature',
    [],
    [
      {
        id: 'request',
        label: 'Request',
        kind: 'start',
        next: 'work',
        done: 'The request is clear enough to start.',
      },
      {
        id: 'work',
        label: 'Work',
        kind: 'agent',
        next: 'review',
        done: 'The work is complete and ready for review.',
        roleHint: 'Worker',
      },
      {
        id: 'review',
        label: 'Review',
        kind: 'agent',
        next: 'finished',
        back: 'work',
        done: 'The work meets the request, or the problems are written down.',
        roleHint: 'Reviewer',
      },
      { id: 'finished', label: 'Finished', kind: 'end' },
    ],
  ),
  build(
    'request-do-check',
    'Request, do, check',
    'The request is written down, one role does it, another checks it.',
    'feature',
    [textField('request', 'What is needed', true)],
    [
      { id: 'request', label: 'Request', kind: 'start', next: 'do', done: 'The request is written down.' },
      {
        id: 'do',
        label: 'Do',
        kind: 'agent',
        next: 'check',
        required: ['request'],
        done: 'Everything asked for has been done.',
        roleHint: 'Doer',
      },
      {
        id: 'check',
        label: 'Check',
        kind: 'agent',
        next: 'finished',
        back: 'do',
        done: 'The result matches the request, or what is wrong is written down.',
        roleHint: 'Checker',
      },
      { id: 'finished', label: 'Finished', kind: 'end' },
    ],
  ),
  build(
    'content',
    'Content: draft, edit, publish',
    'A draft is written, edited, and then published.',
    'docs',
    [textField('topic', 'Topic', true), textField('audience', 'Audience')],
    [
      { id: 'brief', label: 'Brief', kind: 'start', next: 'draft', done: 'Topic and audience are known.' },
      {
        id: 'draft',
        label: 'Draft',
        kind: 'agent',
        next: 'edit',
        required: ['topic'],
        done: 'A complete first draft exists.',
        roleHint: 'Writer',
      },
      {
        id: 'edit',
        label: 'Edit',
        kind: 'agent',
        next: 'publish',
        back: 'draft',
        done: 'The text is clear, correct and in the right tone.',
        roleHint: 'Editor',
      },
      {
        id: 'publish',
        label: 'Publish',
        kind: 'agent',
        next: 'finished',
        done: 'The text is published and the link is recorded.',
        roleHint: 'Publisher',
      },
      { id: 'finished', label: 'Finished', kind: 'end' },
    ],
  ),
  build(
    'support-reply',
    'Support reply',
    'A customer message is triaged, answered, and the answer is checked before it goes out.',
    'support',
    [textField('customer', 'Customer', true), textField('message', 'Their message', true)],
    [
      {
        id: 'triage',
        label: 'Triage',
        kind: 'start',
        next: 'reply',
        done: 'Customer and message are filled in.',
      },
      {
        id: 'reply',
        label: 'Write reply',
        kind: 'agent',
        next: 'check',
        required: ['customer', 'message'],
        done: 'A polite, complete reply is written.',
        roleHint: 'Support agent',
      },
      {
        id: 'check',
        label: 'Check reply',
        kind: 'agent',
        next: 'finished',
        back: 'reply',
        done: 'The reply is correct and safe to send, or what to change is written down.',
        roleHint: 'Support lead',
      },
      { id: 'finished', label: 'Finished', kind: 'end' },
    ],
  ),
];

export const getWorkflowTemplate = (id: string): WorkflowTemplate | undefined =>
  WORKFLOW_TEMPLATES.find((t) => t.id === id);

/** A fresh, independent copy of a template's definition with the owner's key and name. */
export function instantiateTemplate(
  id: string,
  over: { key: string; name?: string },
): WorkflowDefinitionInput | undefined {
  const t = getWorkflowTemplate(id);
  if (!t) return undefined;
  return { ...structuredClone(t.definition), key: over.key, name: over.name ?? t.name };
}

export interface BuiltinCopy {
  definition: WorkflowDefinitionInput;
  /** What the copy lost (shown to the owner): special events, structured data, effects, field sets. */
  notices: string[];
}

const CUSTOM_FIELD_TYPES = new Set<FieldKind>(['text', 'markdown', 'list', 'number', 'boolean', 'url-list']);
const CUSTOM_EVENTS = new Set(['StageCompleted', 'CardSpecified']);

/**
 * A built-in workflow as a custom one (docs/design/workflow-builder.md D5): special events become `StageCompleted`,
 * structured data and effects are dropped, built-in field sets become custom fields. Roles of the built-in keep their
 * names but cannot claim the copy's steps until they list them. The result may still need work to validate.
 */
export function copyBuiltinAsCustom(
  builtin: WorkflowDefinition,
  over: { key: string; name?: string },
): BuiltinCopy {
  const notices = new Set<string>();
  const catalogue = fieldCatalogue(builtin.fieldSet, builtin.customFields);
  const used = new Set<string>();
  const stages = builtin.stages.map((s) => {
    for (const f of s.requiredFields) used.add(f);
    if (s.when) used.add(s.when.field);
    const outcomes = s.outcomes.map((o) => {
      if (o.when) used.add(o.when.field);
      let event = o.event;
      if (!CUSTOM_EVENTS.has(event) || (event === 'CardSpecified' && s.id !== builtin.initialStage)) {
        notices.add(
          `The special step result "${o.event}" became a plain "finished": the built-in behaviour it triggers is gone.`,
        );
        event = 'StageCompleted';
      }
      if (o.data !== 'none') notices.add(`Structured results ("${o.data}") are not carried over.`);
      if (o.effect !== 'none')
        notices.add(
          `The automatic action "${o.effect}" is not carried over (for example spawning bug cards or finalizing).`,
        );
      return { ...o, event, data: 'none' as const, effect: 'none' as const };
    });
    return { ...structuredClone(s), outcomes };
  });
  const customFields: CustomField[] = [];
  for (const key of used) {
    if (key in CARD_COLUMN_FIELDS) continue;
    const meta = catalogue[key];
    if (!meta) continue;
    if (!CUSTOM_FIELD_TYPES.has(meta.kind)) notices.add(`Field "${meta.label}" became a plain text field.`);
    customFields.push({
      key,
      label: meta.label,
      type: CUSTOM_FIELD_TYPES.has(meta.kind) ? (meta.kind as CustomField['type']) : 'text',
      required: false,
    });
  }
  const allowed = CardType.options.filter((t) => !['research', 'feed', 'regression'].includes(t));
  const cardTypes = builtin.cardTypes.filter((t) => (allowed as string[]).includes(t));
  if (cardTypes.length < builtin.cardTypes.length)
    notices.add('Some card types are only available to built-in workflows and were dropped.');
  notices.add('Roles must list the copied steps as theirs before they can work them.');
  return {
    definition: {
      key: over.key,
      version: 1,
      name: over.name ?? `${builtin.name} (copy)`,
      builtIn: false,
      fieldSet: 'custom',
      customFields,
      cardTypes: cardTypes.length > 0 ? cardTypes : ['feature'],
      initialStage: builtin.initialStage,
      stages,
    },
    notices: [...notices],
  };
}
