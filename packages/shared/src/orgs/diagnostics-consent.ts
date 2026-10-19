/**
 * The organization-level consent "Share diagnostic data with Guildwise" (docs/design/ceo-blog-topics.md section 11).
 *
 * DRAFT TEXT. It has not been reviewed under POPIA. Customer organizations do not see the switch until it has been:
 * the server flag `AOM_DIAGNOSTICS_CONSENT_CUSTOMERS` (default off) gates the setting and the toggle; the platform
 * organization (the owner's own) is always allowed. Changing the text means a new `DIAGNOSTICS_CONSENT_VERSION`.
 */
export const DIAGNOSTICS_CONSENT_VERSION = '2026-10-19-draft';

export const DIAGNOSTICS_CONSENT_TITLE = 'Share diagnostic data with Guildwise';

export const DIAGNOSTICS_CONSENT_TEXT: readonly string[] = [
  'When this is on, your CEO may share generic, scrubbed records of problems it notices in your organization (repeated failures, loops, corrections) with Guildwise.',
  'Guildwise uses them to build better features for you, and as research topics for articles on the Guildwise blog.',
  'What leaves: one generic question per topic (no names, no projects, no repositories, no hosts, no people, no code). What never leaves: your cards, chats, files, secrets and customer data.',
  'The Owner is asked before anything is sent: you accept, edit or reject each question.',
  'People at Guildwise with database access could, in principle, correlate the time a topic arrived with activity in your organization.',
  'You can switch this off at any time. Topics that have not been written about yet are withdrawn.',
];
