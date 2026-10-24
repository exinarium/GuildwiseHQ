/**
 * Starter gallery (S-B2): a short, curated list of the built-in personas and playbooks worth trying first, each with a one-line
 * outcome. Shown on first run and under Settings > Capabilities > Starter gallery; "Use" hires the persona (through the review and
 * hire dialogs) or runs the playbook as a guided session. The texts are the built-ins in `packages/capabilities`.
 */
export interface StarterEntry {
  kind: 'persona' | 'playbook';
  /** The registry key of the built-in. */
  key: string;
  title: string;
  /** What you get, in one line. */
  outcome: string;
  /** The group the gallery shows it under. */
  group: 'Think it through' | 'Ship and report' | 'Look after it';
}

export const STARTER_GALLERY: readonly StarterEntry[] = [
  {
    kind: 'playbook',
    key: 'product-brief',
    title: 'Product brief',
    outcome: 'A one-to-two page brief from a rough idea, built from your own answers.',
    group: 'Think it through',
  },
  {
    kind: 'playbook',
    key: 'brainstorm',
    title: 'Brainstorm',
    outcome: 'A ranked shortlist of ideas you chose, not a pile of notes.',
    group: 'Think it through',
  },
  {
    kind: 'persona',
    key: 'analyst',
    title: 'Analyst',
    outcome: 'Asks one question at a time and turns your answers into a clear brief.',
    group: 'Think it through',
  },
  {
    kind: 'persona',
    key: 'devils-advocate',
    title: "Devil's advocate",
    outcome: 'Challenges a plan and names how it could fail before it does.',
    group: 'Think it through',
  },
  {
    kind: 'playbook',
    key: 'release-notes',
    title: 'Release notes',
    outcome: 'Customer-ready release notes from the list of what shipped.',
    group: 'Ship and report',
  },
  {
    kind: 'playbook',
    key: 'weekly-status',
    title: 'Weekly status',
    outcome: 'A one-page status update with the risks and the asks in it.',
    group: 'Ship and report',
  },
  {
    kind: 'playbook',
    key: 'pr-triage',
    title: 'Pull request triage',
    outcome: 'Open pull requests sorted into merge now, needs work, decide and close.',
    group: 'Ship and report',
  },
  {
    kind: 'playbook',
    key: 'incident-followup',
    title: 'Incident follow-up',
    outcome: 'A blameless write-up with a few owned actions and dates.',
    group: 'Look after it',
  },
  {
    kind: 'persona',
    key: 'security',
    title: 'Security reviewer',
    outcome: 'Reads a plan for abuse, data exposure and access problems and ranks them.',
    group: 'Look after it',
  },
  {
    kind: 'persona',
    key: 'ops',
    title: 'Operations',
    outcome: 'Asks how it will be deployed, monitored and supported at three in the morning.',
    group: 'Look after it',
  },
  {
    kind: 'persona',
    key: 'cost-hawk',
    title: 'Cost hawk',
    outcome: 'Puts a price on a plan and finds the cheapest version that is enough.',
    group: 'Look after it',
  },
];

/** The entries whose built-in is present (a key removed from the built-ins is not offered). */
export function availableStarters(has: (kind: StarterEntry['kind'], key: string) => boolean): StarterEntry[] {
  return STARTER_GALLERY.filter((e) => has(e.kind, e.key));
}
