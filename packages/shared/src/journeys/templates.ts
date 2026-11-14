import type { RulePack } from '../ledger/rule-packs.ts';
import type { JourneyDefinition, JourneyHandoff, JourneyStep } from './schema.ts';

/** The industry a catalogue template is made for (same values as the industry rule packs). */
export type JourneyTemplateIndustry = NonNullable<RulePack['industry']>;

export interface JourneyTemplate {
  id: string;
  name: string;
  description: string;
  /** Absent: a general template. */
  industry?: JourneyTemplateIndustry;
  definition: JourneyDefinition;
}

type Spec = [
  id: string,
  label: string,
  kind: 'workflow' | 'wait' | 'gate',
  workflowKey?: string,
  config?: Record<string, unknown>,
];

function build(
  name: string,
  description: string,
  recordType: JourneyDefinition['recordType'],
  specs: Spec[],
  extra: Array<Omit<JourneyHandoff, 'id'>>,
): JourneyDefinition {
  const steps: JourneyStep[] = specs.map(([id, label, kind, workflowKey, config]) =>
    kind === 'workflow'
      ? { kind, id, label, workflowKey: workflowKey ?? null, fieldsIn: [] }
      : ({ kind, id, label, ...(config ?? {}) } as JourneyStep),
  );
  const handoffs: JourneyHandoff[] = [];
  const add = (h: Omit<JourneyHandoff, 'id'>): void => {
    handoffs.push({ ...h, id: `h${handoffs.length + 1}` });
  };
  specs.forEach(([id], i) => {
    // Order matters: the specific handoffs of a step come before its "done -> next".
    for (const e of extra.filter((x) => x.from === id && x.on !== 'done')) add(e);
    const next = specs[i + 1];
    const loop = extra.find((x) => x.from === id && x.on === 'done');
    if (loop) add(loop);
    else if (next) add({ from: id, on: 'done', to: next[0] });
  });
  return {
    name,
    description,
    recordType,
    firstStepId: specs[0]?.[0] ?? 'start',
    steps,
    handoffs,
  };
}

export const RENTALS_TEMPLATE_ID = 'rentals';
export const ACCOUNTING_TEMPLATE_ID = 'accounting-client-onboarding';
export const LAW_TEMPLATE_ID = 'law-client-matter';

const uploadWait = () => ({
  waitFor: { kind: 'form', formId: null, purpose: 'upload', send: { via: 'desk' } },
  duration: { amount: 7, unit: 'days' },
  onTimeout: { action: 'remind', maxReminders: 2, afterLast: 'escalate' },
});

export const JOURNEY_TEMPLATES: JourneyTemplate[] = [
  {
    id: RENTALS_TEMPLATE_ID,
    name: 'Rentals: lead to monthly rent',
    description:
      'A tenant from first enquiry to monthly rent, with a wait for forms and documents and an approval gate. Pick the form for the wait.',
    definition: build(
      'Rentals',
      'Lead, viewing, application, documents, screening, approval, lease, invoice, move-in and monthly rent.',
      'client',
      [
        ['lead', 'Lead', 'workflow', 'business-enquiry'],
        ['viewing', 'Viewing', 'workflow', 'business-follow-up'],
        ['application', 'Application', 'workflow', 'business-document-request'],
        [
          'wait_documents',
          'Wait for forms and documents',
          'wait',
          undefined,
          {
            waitFor: { kind: 'form', formId: null, purpose: 'upload', send: { via: 'desk' } },
            duration: { amount: 5, unit: 'days' },
            onTimeout: { action: 'remind', maxReminders: 2, afterLast: 'escalate' },
          },
        ],
        ['screening', 'Screening', 'workflow', 'business-report'],
        [
          'approval',
          'Approval',
          'gate',
          undefined,
          { approver: { kind: 'project_owner' }, question: 'Approve this application?' },
        ],
        ['lease_signed', 'Lease signed', 'workflow', 'business-document-request'],
        ['deposit_invoice', 'Deposit and first-rent invoice', 'workflow', 'business-quote'],
        ['move_in', 'Move-in', 'workflow', 'business-follow-up'],
        ['monthly_rent', 'Monthly rent', 'workflow', 'business-reminder'],
      ],
      [
        { from: 'lead', on: 'cancelled', to: 'end', label: 'Lead lost' },
        { from: 'screening', on: 'cancelled', to: 'end', label: 'Application declined' },
        { from: 'approval', on: 'rejected', to: 'end', label: 'Application declined' },
        { from: 'monthly_rent', on: 'cancelled', to: 'end', label: 'Lease ended' },
        { from: 'monthly_rent', on: 'done', to: 'monthly_rent', label: 'Next month' },
      ],
    ),
  },
  {
    id: ACCOUNTING_TEMPLATE_ID,
    name: 'Accounting: client onboarding to filing',
    description:
      'A client from first enquiry through engagement letter, records collection, preparation, review, sign-off and filing, then the next period. Pick the form for the wait.',
    industry: 'accounting',
    definition: build(
      'Accounting client',
      'Enquiry, proposal, engagement letter, document request, records, preparation, review, sign-off, filing, invoice and next period.',
      'client',
      [
        ['enquiry', 'Enquiry', 'workflow', 'business-enquiry'],
        ['proposal', 'Scope and fee proposal', 'workflow', 'business-quote'],
        ['engagement_letter', 'Engagement letter signed', 'workflow', 'business-document-request'],
        ['document_request', 'Document request', 'workflow', 'business-document-request'],
        ['wait_documents', 'Wait for records and documents', 'wait', undefined, uploadWait()],
        ['preparation', 'Preparation', 'workflow', 'business-report'],
        [
          'review',
          'Review',
          'gate',
          undefined,
          {
            approver: { kind: 'project_owner' },
            question: 'Is the work ready to send to the client for sign-off?',
          },
        ],
        ['client_signoff', 'Client sign-off', 'workflow', 'business-document-request'],
        ['filing', 'Filing', 'workflow', 'business-follow-up'],
        ['invoice', 'Invoice', 'workflow', 'business-quote'],
        ['next_period', 'Close and plan the next period', 'workflow', 'business-reminder'],
      ],
      [
        { from: 'enquiry', on: 'cancelled', to: 'end', label: 'Enquiry lost' },
        { from: 'engagement_letter', on: 'cancelled', to: 'end', label: 'Engagement declined' },
        { from: 'review', on: 'rejected', to: 'preparation', label: 'Changes needed' },
        { from: 'next_period', on: 'cancelled', to: 'end', label: 'Engagement ended' },
        { from: 'next_period', on: 'done', to: 'document_request', label: 'Next period' },
      ],
    ),
  },
  {
    id: LAW_TEMPLATE_ID,
    name: 'Law: matter intake to close-out',
    description:
      'A matter from first enquiry through conflict check, engagement letter, client documents, matter work, review and close-out. Pick the form for the wait.',
    industry: 'law',
    definition: build(
      'Law matter',
      'Intake, conflict check, engagement letter, fee estimate, document request, documents, matter work, review, final invoice and close-out.',
      'matter',
      [
        ['intake', 'Intake', 'workflow', 'business-enquiry'],
        ['conflict_check', 'Conflict check', 'workflow', 'business-report'],
        ['engagement_letter', 'Engagement letter signed', 'workflow', 'business-document-request'],
        ['fee_estimate', 'Fee estimate and deposit invoice', 'workflow', 'business-quote'],
        ['document_request', 'Document request', 'workflow', 'business-document-request'],
        ['wait_documents', 'Wait for client forms and documents', 'wait', undefined, uploadWait()],
        ['matter_work', 'Matter work', 'workflow', 'business-follow-up'],
        [
          'review',
          'Review',
          'gate',
          undefined,
          { approver: { kind: 'project_owner' }, question: 'Is the matter ready to close out?' },
        ],
        ['final_invoice', 'Final invoice', 'workflow', 'business-quote'],
        ['close_out', 'Close-out', 'workflow', 'business-report'],
      ],
      [
        { from: 'intake', on: 'cancelled', to: 'end', label: 'Enquiry lost' },
        { from: 'conflict_check', on: 'cancelled', to: 'end', label: 'Conflict found: matter declined' },
        { from: 'engagement_letter', on: 'cancelled', to: 'end', label: 'Engagement declined' },
        { from: 'review', on: 'rejected', to: 'matter_work', label: 'More work needed' },
        { from: 'close_out', on: 'done', to: 'end', label: 'Matter closed' },
      ],
    ),
  },
];

export const getJourneyTemplate = (id: string): JourneyTemplate | undefined =>
  JOURNEY_TEMPLATES.find((t) => t.id === id);
