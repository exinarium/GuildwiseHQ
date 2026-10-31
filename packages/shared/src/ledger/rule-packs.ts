import { z } from 'zod';

/**
 * Rule packs (business mode): built-in sets of standing orders an organization installs in one action.
 * `server_check`: a server gate refuses the violation; `agent_instruction`: agents are only told in their brief.
 */
export const EnforcedBy = z.enum(['server_check', 'agent_instruction']);
export type EnforcedBy = z.infer<typeof EnforcedBy>;

/**
 * The server gates a rule may point at. Each id needs a proof in apps/server/test/rule-pack-server-checks.test.ts
 * (a type error otherwise). Empty in this release: no shipped rule forbids exactly what an existing gate refuses.
 */
export const SERVER_CHECKS = {} as const satisfies Record<string, { summary: string }>;
export type ServerCheckId = keyof typeof SERVER_CHECKS;

export interface RulePackRule {
  /** Stable within the pack (kebab-case); never reused for different text. */
  id: string;
  title: string;
  body: string;
  scope: 'standing_order';
  enforcedBy: EnforcedBy;
  /** Required when enforcedBy is server_check, absent otherwise. */
  serverCheck?: ServerCheckId;
  /** Where the text comes from: file and section of the research. */
  source: string;
}

export interface RulePack {
  id: string;
  version: number;
  name: string;
  description: string;
  kind: 'general' | 'industry';
  industry?: 'real_estate' | 'accounting' | 'law';
  rules: RulePackRule[];
}

const GP = 'game-plan';
const rule = (id: string, text: string, source: string): RulePackRule => ({
  id,
  title: text,
  body: text,
  scope: 'standing_order',
  enforcedBy: 'agent_instruction',
  source,
});

/**
 * Rule text is copied from the research (`2026-10-27-business-mode-game-plan.md`, `industry-roadmap.md`). A
 * "Never:" prefix marks a fragment the file lists under a "Never" heading.
 */
export const RULE_PACKS: readonly RulePack[] = [
  {
    id: 'core',
    version: 1,
    name: 'Core rules',
    description: 'Rule packs: tick boxes for every business.',
    kind: 'general',
    rules: [
      rule(
        'never-message-without-approval',
        'never message a client without approval',
        `${GP} §Ledger and vault made easy, change 2`,
      ),
      rule(
        'no-professional-advice',
        'no legal/medical/tax advice',
        `${GP} §Ledger and vault made easy, change 2`,
      ),
      rule(
        'marketing-opted-in-only',
        'POPIA marketing only to opted-in',
        `${GP} §Ledger and vault made easy, change 2`,
      ),
      rule(
        'never-quote-outside-price-list',
        'never quote outside price list',
        `${GP} §Ledger and vault made easy, change 2`,
      ),
    ],
  },
  {
    id: 'outbound',
    version: 1,
    name: 'Outbound',
    description: 'Default "Outbound" rule pack: SA outbound rules.',
    kind: 'general',
    rules: [
      rule(
        'popia-s69-consent',
        'POPIA s69 consent, sender named, stop offered',
        `${GP} §Revenue channels, SA outbound rules`,
      ),
      rule(
        'cpa-calling-hours',
        'CPA calling hours (no Sundays/public holidays; Sat 09:00–13:00; weekdays 08:00–20:00)',
        `${GP} §Revenue channels, SA outbound rules`,
      ),
      rule(
        'never-unconsented-numbers',
        'Never: registry-blocked/unconsented numbers',
        `${GP} §Revenue channels, Never`,
      ),
      rule('never-cold-whatsapp', 'Never: cold WhatsApp', `${GP} §Revenue channels, Never`),
      rule('never-outside-legal-hours', 'Never: outside legal hours', `${GP} §Revenue channels, Never`),
      rule(
        'never-ai-calls-undisclosed',
        'Never: AI calls without disclosure',
        `${GP} §Revenue channels, Never`,
      ),
      rule(
        'never-record-without-consent',
        'Never: recording without consent',
        `${GP} §Revenue channels, Never`,
      ),
      rule('never-ignore-stop', 'Never: ignoring STOP', `${GP} §Revenue channels, Never`),
    ],
  },
  {
    id: 'real-estate',
    version: 1,
    name: 'Real estate',
    description:
      'Real estate (estate agencies, rentals): recommended rules for the release 1.4.0 industry bundle.',
    kind: 'industry',
    industry: 'real_estate',
    rules: [
      rule(
        'price-value-statements-approved',
        'price/value statements approved',
        `${GP} §Vertical packs, Real estate`,
      ),
      rule(
        'no-marketing-without-consent',
        'no marketing without consent',
        `${GP} §Vertical packs, Real estate`,
      ),
      rule('legal-notices-human', 'legal notices human', `${GP} §Vertical packs, Real estate`),
      rule('id-verification-human', 'ID verification human', `${GP} §Vertical packs, Real estate`),
      rule('fica-human-sign-off', 'FICA human sign-off', `${GP} §Vertical packs, Rules`),
    ],
  },
  {
    id: 'accounting',
    version: 1,
    name: 'Accounting firms',
    description: 'Accounting firms: recommended rules for the release 1.4.0 industry bundle.',
    kind: 'industry',
    industry: 'accounting',
    rules: [
      rule(
        'bank-rec-read-only',
        'bank-rec exception summary (read-only)',
        `${GP} §Vertical packs, Accounting`,
      ),
      rule('fica-human-sign-off', 'FICA human sign-off', `${GP} §Vertical packs, Rules`),
      rule(
        'never-verify-identity-or-file',
        'Never: verify identity, file to SARS/courts',
        `${GP} §Seven business roles, Compliance Officer`,
      ),
    ],
  },
  {
    id: 'law',
    version: 1,
    name: 'Law firms',
    description: 'Law firms: recommended rules for the release 1.4.0 industry bundle.',
    kind: 'industry',
    industry: 'law',
    rules: [
      rule('partner-decides', 'partner decides', `industry-roadmap §Release 1.4.0, Law firms`),
      rule(
        'fee-earner-verifies-every-date',
        'fee-earner verifies every date',
        `industry-roadmap §Release 1.4.0, Law firms`,
      ),
      rule(
        'ai-never-moves-trust-money',
        'AI never moves trust money',
        `industry-roadmap §Release 1.4.0, Law firms`,
      ),
      rule('lpa-trust', 'LPA s86–87 trust', `${GP} §Vertical packs, Rules`),
      rule('ai-citations-reviewed', 'AI citations reviewed', `${GP} §Vertical packs, Rules`),
    ],
  },
];

export const rulePackById = (id: string): RulePack | undefined => RULE_PACKS.find((p) => p.id === id);

/** Display labels, one place. */
export const ENFORCED_BY_LABEL: Record<EnforcedBy, string> = {
  server_check: 'Guildwise (server check)',
  agent_instruction: 'Agent instruction',
};

/** One sentence per value, shown as text (a tooltip does not show on touch). */
export const ENFORCED_BY_EXPLAIN: Record<EnforcedBy, string> = {
  server_check: 'Guildwise refuses the action on the server, whatever an agent does.',
  agent_instruction: 'Agents are told this rule in their brief. Guildwise does not block a violation itself.',
};

/** The value a ledger row shows: the pack's own while the rule is unedited, else agent instruction. */
export function enforcedByFor(row: {
  rulePackId: string | null;
  rulePackRuleId: string | null;
  version: number;
}): EnforcedBy {
  if (!row.rulePackId || !row.rulePackRuleId || row.version > 1) return 'agent_instruction';
  const r = rulePackById(row.rulePackId)?.rules.find((x) => x.id === row.rulePackRuleId);
  return r?.enforcedBy ?? 'agent_instruction';
}
