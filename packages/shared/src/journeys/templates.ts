import type { JourneyDefinition, JourneyHandoff, JourneyStep } from './schema.ts';

export interface JourneyTemplate {
  id: string;
  name: string;
  description: string;
  definition: JourneyDefinition;
}

type Spec = [id: string, label: string, kind: 'workflow' | 'wait' | 'gate', workflowKey?: string];

function build(
  name: string,
  description: string,
  recordType: JourneyDefinition['recordType'],
  specs: Spec[],
  extra: Array<Omit<JourneyHandoff, 'id'>>,
): JourneyDefinition {
  const steps: JourneyStep[] = specs.map(([id, label, kind, workflowKey]) =>
    kind === 'workflow'
      ? { kind, id, label, workflowKey: workflowKey ?? null, fieldsIn: [] }
      : { kind, id, label },
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

export const JOURNEY_TEMPLATES: JourneyTemplate[] = [
  {
    id: RENTALS_TEMPLATE_ID,
    name: 'Rentals: lead to monthly rent',
    description:
      'A tenant from first enquiry to monthly rent. The wait and the approval gate are placeholders until waits and gates are available.',
    definition: build(
      'Rentals',
      'Lead, viewing, application, documents, screening, approval, lease, invoice, move-in and monthly rent.',
      'client',
      [
        ['lead', 'Lead', 'workflow', 'business-enquiry'],
        ['viewing', 'Viewing', 'workflow', 'business-follow-up'],
        ['application', 'Application', 'workflow', 'business-document-request'],
        ['wait_documents', 'Wait for forms and documents', 'wait'],
        ['screening', 'Screening', 'workflow', 'business-report'],
        ['approval', 'Approval', 'gate'],
        ['lease_signed', 'Lease signed', 'workflow', 'business-document-request'],
        ['deposit_invoice', 'Deposit and first-rent invoice', 'workflow', 'business-quote'],
        ['move_in', 'Move-in', 'workflow', 'business-follow-up'],
        ['monthly_rent', 'Monthly rent', 'workflow', 'business-reminder'],
      ],
      [
        { from: 'lead', on: 'cancelled', to: 'end', label: 'Lead lost' },
        { from: 'screening', on: 'cancelled', to: 'end', label: 'Application declined' },
        { from: 'monthly_rent', on: 'cancelled', to: 'end', label: 'Lease ended' },
        { from: 'monthly_rent', on: 'done', to: 'monthly_rent', label: 'Next month' },
      ],
    ),
  },
];

export const getJourneyTemplate = (id: string): JourneyTemplate | undefined =>
  JOURNEY_TEMPLATES.find((t) => t.id === id);
