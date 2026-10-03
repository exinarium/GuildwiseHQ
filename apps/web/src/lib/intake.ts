import type { DeskItemDto, EscalationStep, IntakeDto } from '@aom/shared';
import { type ExternalRef, parseExternalRef } from '@aom/shared';

/** What the Intake form will treat the input as: a Jira key, a GitHub issue, or a plain description. */
export function describeSource(text: string): { label: string; ref: ExternalRef | null } {
  const ref = parseExternalRef(text);
  if (!ref) return { label: 'Free text: the BA works from your description.', ref: null };
  return {
    ref,
    label: `${ref.system === 'jira' ? 'Jira ticket' : 'GitHub issue'} ${ref.key}: the BA reads it on your workstation (read-only).`,
  };
}

/** The status line of an intake. */
export function intakeStatusText(i: Pick<IntakeDto, 'status' | 'mappedProjectKey'>): string {
  if (i.status === 'mapped') return `Mapped to ${i.mappedProjectKey}`;
  if (i.status === 'unmapped') return 'Waiting for you to pick the project';
  return 'Open';
}

/** "Bea (builder) asked", "Sam (builder)", "Ben (ba)", "the desk" for one step of the escalation trail. */
export function trailLabel(s: EscalationStep): string {
  const who = s.agentName
    ? `${s.agentName}${s.role ? ` (${s.role})` : ''}`
    : s.step === 'desk'
      ? 'the desk'
      : 'the manager';
  if (s.step === 'asked') return `${who} asked`;
  if (s.step === 'answered') return `answered by ${who}`;
  if (s.step === 'merged') return s.note ?? 'merged with a similar open question';
  if (s.step === 'desk') return 'the desk';
  return who;
}

/** The trail is worth showing once the question travelled beyond the asker, or an agent answered it. */
export const hasTrail = (i: Pick<DeskItemDto, 'escalationTrail'>): boolean =>
  (i.escalationTrail?.length ?? 0) > 1;
