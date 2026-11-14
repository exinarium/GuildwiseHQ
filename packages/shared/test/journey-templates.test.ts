import { describe, expect, it } from 'vitest';
import {
  ACCOUNTING_TEMPLATE_ID,
  getJourneyTemplate,
  JOURNEY_TEMPLATES,
  JourneyDefinitionSchema,
  LAW_TEMPLATE_ID,
  nextMove,
  validateJourney,
} from '../src/journeys/index.ts';
import { RULE_PACKS } from '../src/ledger/rule-packs.ts';
import { BUSINESS_WORKFLOW_KEY, isBusinessWorkflowKey } from '../src/workflows/business.ts';

const ctx = (result: 'done' | 'cancelled', outcome?: 'approved' | 'rejected') => ({
  result,
  outcome,
  card: null,
  record: { type: 'client' as const, status: 'active' as const },
  visits: 1,
});
const stepIds = (id: string) => getJourneyTemplate(id)!.definition.steps.map((s) => s.id);

describe('journey template catalogue', () => {
  it('has unique kebab-case ids and a name and description for each template', () => {
    const ids = JOURNEY_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of JOURNEY_TEMPLATES) {
      expect(t.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it.each(JOURNEY_TEMPLATES.map((t) => [t.id, t] as const))('%s parses and round-trips', (_id, t) => {
    const parsed = JourneyDefinitionSchema.parse(t.definition);
    expect(parsed).toEqual(t.definition);
    expect(t.definition.firstStepId).toBe(t.definition.steps[0]!.id);
  });

  it.each(JOURNEY_TEMPLATES.map((t) => [t.id, t] as const))(
    '%s only lacks the form pick and uses business workflows',
    (_id, t) => {
      const v = validateJourney(t.definition, { enabledWorkflowKeys: Object.values(BUSINESS_WORKFLOW_KEY) });
      expect(v.errors.map((e) => e.code)).toEqual(['no_form']);
      const warn = v.warnings.map((e) => e.code);
      expect(warn).not.toContain('no_reject_handoff');
      expect(warn).not.toContain('unreachable');
      for (const s of t.definition.steps) {
        if (s.kind === 'workflow') expect(isBusinessWorkflowKey(s.workflowKey ?? '')).toBe(true);
      }
    },
  );

  it('tags accounting and law, leaves rentals untagged, and keeps rentals first', () => {
    expect(JOURNEY_TEMPLATES[0]!.id).toBe('rentals');
    expect(getJourneyTemplate('rentals')?.industry).toBeUndefined();
    const a = getJourneyTemplate(ACCOUNTING_TEMPLATE_ID)!;
    const l = getJourneyTemplate(LAW_TEMPLATE_ID)!;
    expect(a.industry).toBe('accounting');
    expect(a.definition.recordType).toBe('client');
    expect(l.industry).toBe('law');
    expect(l.definition.recordType).toBe('matter');
    expect(getJourneyTemplate('nope')).toBeUndefined();
  });

  it('only uses industries that rule packs know', () => {
    const known = RULE_PACKS.flatMap((p) => p.industry ?? []);
    for (const t of JOURNEY_TEMPLATES) if (t.industry) expect(known).toContain(t.industry);
  });

  it('pins the step order of the accounting and law templates', () => {
    expect(stepIds(ACCOUNTING_TEMPLATE_ID)).toEqual([
      'enquiry',
      'proposal',
      'engagement_letter',
      'document_request',
      'wait_documents',
      'preparation',
      'review',
      'client_signoff',
      'filing',
      'invoice',
      'next_period',
    ]);
    expect(stepIds(LAW_TEMPLATE_ID)).toEqual([
      'intake',
      'conflict_check',
      'engagement_letter',
      'fee_estimate',
      'document_request',
      'wait_documents',
      'matter_work',
      'review',
      'final_invoice',
      'close_out',
    ]);
  });

  it('walks the accounting and law handoffs', () => {
    const a = getJourneyTemplate(ACCOUNTING_TEMPLATE_ID)!.definition;
    const l = getJourneyTemplate(LAW_TEMPLATE_ID)!.definition;
    const to = (m: ReturnType<typeof nextMove>) => (m.kind === 'next' ? m.handoff.to : m.kind);
    expect(to(nextMove(a, 'review', ctx('cancelled', 'rejected')))).toBe('preparation');
    expect(to(nextMove(a, 'review', ctx('done', 'approved')))).toBe('client_signoff');
    expect(to(nextMove(a, 'next_period', ctx('done')))).toBe('document_request');
    expect(to(nextMove(l, 'review', ctx('cancelled', 'rejected')))).toBe('matter_work');
    expect(to(nextMove(l, 'close_out', ctx('done')))).toBe('end');
    expect(to(nextMove(l, 'conflict_check', ctx('cancelled')))).toBe('end');
  });

  it('keeps rentals the only client template with 10 steps', () => {
    // e2e/tests/journeys.spec.ts matches the text "10 steps · for a client" and must find one template.
    const ten = JOURNEY_TEMPLATES.filter((t) => t.definition.recordType === 'client' && t.definition.steps.length === 10);
    expect(ten.map((t) => t.id)).toEqual(['rentals']);
  });
});
