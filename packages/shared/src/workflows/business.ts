import { BUSINESS_CARD_TYPE_LABELS, BUSINESS_CARD_TYPES, type BusinessCardType } from '../cards/types.ts';
import { type CustomField, type WorkflowDefinition, WorkflowDefinitionSchema } from './schema.ts';

/** Workflow key of the shipped default workflow of each business card type. */
export const BUSINESS_WORKFLOW_KEY: Record<BusinessCardType, string> = {
  enquiry: 'business-enquiry',
  follow_up: 'business-follow-up',
  document_request: 'business-document-request',
  reminder: 'business-reminder',
  report: 'business-report',
  quote: 'business-quote',
};

/** The business role that prepares the output of each type (the `prepare` step's `claimRole`). */
export const BUSINESS_PREPARE_ROLE: Record<BusinessCardType, string> = {
  enquiry: 'front_desk',
  follow_up: 'follow_up_assistant',
  document_request: 'compliance_officer',
  report: 'operations_analyst',
  reminder: 'compliance_officer',
  quote: 'front_desk',
};

export const isBusinessWorkflowKey = (key: string): boolean =>
  (Object.values(BUSINESS_WORKFLOW_KEY) as string[]).includes(key);

const text = (key: string, label: string, required: boolean): CustomField => ({
  key,
  label,
  type: 'text',
  required,
});
const markdown = (key: string, label: string, required: boolean): CustomField => ({
  key,
  label,
  type: 'markdown',
  required,
});
const date = (key: string, label: string, required: boolean): CustomField => ({
  key,
  label,
  type: 'text',
  required,
  format: 'date',
});

/** The fields of each type, in display order. */
export const BUSINESS_CARD_FIELDS: Record<BusinessCardType, CustomField[]> = {
  enquiry: [
    text('whoAsked', 'Who asked', true),
    text('channel', 'Channel', false),
    markdown('question', 'Question', true),
    date('dueBy', 'Due by', false),
  ],
  follow_up: [
    text('person', 'Who', true),
    markdown('about', 'About what', true),
    date('dueDate', 'Due date', false),
    text('linkedCard', 'Linked card', false),
  ],
  document_request: [
    text('document', 'Document', true),
    text('fromWhom', 'From whom', true),
    date('deadline', 'Deadline', false),
  ],
  reminder: [
    markdown('what', 'What', true),
    date('remindOn', 'When', true),
    text('forWhom', 'For whom', true),
  ],
  report: [
    text('subject', 'Subject', true),
    text('period', 'Period', false),
    text('audience', 'Audience', false),
  ],
  quote: [
    text('customer', 'Customer', true),
    markdown('scope', 'Items / scope', true),
    { key: 'amount', label: 'Amount', type: 'number', required: false },
    date('validUntil', 'Valid until', false),
  ],
};

const OUTPUT: Record<BusinessCardType, string> = {
  enquiry: 'A reply to the question is written, complete and ready to send',
  follow_up: 'The follow-up message is written, complete and ready to send',
  document_request: 'The request for the document is written, complete and ready to send',
  reminder: 'The reminder text is written, complete and ready to send',
  report: 'The report is written, complete and ready to hand over',
  quote: 'The quote is written, complete and ready to send',
};

const outcome = (
  id: string,
  to: string,
  kind: 'success' | 'failure',
  event: 'StageCompleted' | 'CardSpecified',
  rework = false,
) => ({
  id,
  label: id,
  kind,
  to,
  event,
  data: 'none' as const,
  rework,
  effect: 'none' as const,
});

/**
 * The default workflow of one business card type: request (the person fills the fields) -> prepare (the business role
 * writes the output) -> approve (the person who started the card approves or sends it back) -> done. No repository,
 * branch, build, review or merge step: the approved output is the completion.
 */
export function businessWorkflow(type: BusinessCardType): WorkflowDefinition {
  const fields = BUSINESS_CARD_FIELDS[type];
  return WorkflowDefinitionSchema.parse({
    key: BUSINESS_WORKFLOW_KEY[type],
    version: 1,
    name: BUSINESS_CARD_TYPE_LABELS[type],
    builtIn: false,
    fieldSet: 'custom',
    customFields: fields,
    cardTypes: [type],
    initialStage: 'request',
    stages: [
      {
        id: 'request',
        label: 'Request',
        column: 'Request',
        kind: 'manual',
        claimRole: null,
        seniorOnly: false,
        requiredFields: [],
        doneCriteria: 'The fields are filled in and the card is started.',
        outcomes: [outcome('specified', 'prepare', 'success', 'CardSpecified')],
        worktree: 'none',
        rebaseBefore: false,
        syncMainBefore: false,
        maxShiftMinutes: 60,
        requiredCapabilities: [],
        environment: 'none',
      },
      {
        id: 'prepare',
        label: 'Prepare',
        column: 'Preparing',
        kind: 'agent',
        claimRole: BUSINESS_PREPARE_ROLE[type],
        seniorOnly: false,
        requiredFields: fields.filter((f) => f.required).map((f) => f.key),
        doneCriteria: `${OUTPUT[type]}; the full text is in the handoff note.`,
        outcomes: [outcome('done', 'approve', 'success', 'StageCompleted')],
        worktree: 'none',
        rebaseBefore: false,
        syncMainBefore: false,
        maxShiftMinutes: 30,
        requiredCapabilities: [],
        environment: 'none',
      },
      {
        id: 'approve',
        label: 'Approve',
        column: 'Approval',
        kind: 'human',
        human: { purpose: 'approval', approver: { kind: 'starter' } },
        claimRole: null,
        seniorOnly: false,
        requiredFields: [],
        doneCriteria: 'The person who started the card approves the output or sends it back with a comment.',
        outcomes: [
          outcome('approve', 'done', 'success', 'StageCompleted'),
          outcome('send_back', 'prepare', 'failure', 'StageCompleted', true),
        ],
        worktree: 'none',
        rebaseBefore: false,
        syncMainBefore: false,
        maxShiftMinutes: 60,
        requiredCapabilities: [],
        environment: 'none',
      },
      {
        id: 'done',
        label: 'Done',
        column: 'Done',
        kind: 'terminal',
        claimRole: null,
        seniorOnly: false,
        requiredFields: [],
        doneCriteria: '',
        outcomes: [],
        worktree: 'none',
        rebaseBefore: false,
        syncMainBefore: false,
        maxShiftMinutes: 60,
        requiredCapabilities: [],
        environment: 'none',
      },
    ],
  });
}

/** The six shipped business workflows, installed per business organization. */
export const BUSINESS_WORKFLOWS: readonly WorkflowDefinition[] = BUSINESS_CARD_TYPES.map(businessWorkflow);

/** The field that holds the due date of each business card type (the brief lists what is due or overdue). */
export const BUSINESS_DUE_FIELDS: Partial<Record<BusinessCardType, string>> = {
  follow_up: 'dueDate',
  reminder: 'remindOn',
  enquiry: 'dueBy',
  document_request: 'deadline',
  quote: 'validUntil',
};
