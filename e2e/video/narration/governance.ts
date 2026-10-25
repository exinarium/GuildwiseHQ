import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Governance video (slug `governance`). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Governance is how you stay in charge of agents that act on their own: you approve from a notification, you see exactly what an agent may do, you export the audit trail, and you offboard people cleanly.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Approve from a notification',
    banner: 'One tap, once',
    cues: [
      {
        id: 'c1-a',
        text: 'When an approval is waiting for you, the push notification carries Approve and Reject buttons. A question with options shows its first two options instead.',
      },
      {
        id: 'c1-b',
        text: 'A button opens a small page that asks you to sign in, shows what you are deciding, and waits. Opening the link changes nothing. Only your own press of the button does.',
      },
      {
        id: 'c1-c',
        text: 'The link works once, for fifteen minutes, and only for you. Every use is on the audit log.',
      },
    ],
  },
  {
    title: 'What it may do',
    banner: 'Tools, grants and gates',
    cues: [
      {
        id: 'c2-a',
        text: "On Agents, click What it may do on an agent's card. One view shows its tools, the repositories and projects it can reach, its provider and which key pays.",
      },
      {
        id: 'c2-b',
        text: 'It also shows who the agent may delegate to, including what its role gives it and any exclusions, its playbooks, skills and packs, and what it has cost against its budgets.',
      },
      {
        id: 'c2-c',
        text: 'Under Approval gates, switch on Ask me before, for example merge and push. That action then pauses and lands on your Desk as an approval. Outbound mail always asks.',
      },
    ],
  },
  {
    title: 'Audit export',
    banner: 'The audit trail',
    cues: [
      {
        id: 'c3-a',
        text: 'Owners and Admins open Organization, then Audit log. Pick a date range of up to a year, optionally one person, and a format, CSV or JSON, and click Download.',
      },
      {
        id: 'c3-b',
        text: 'It lists what people did, not message text, and anything that looks like a secret is masked. The export itself is recorded too.',
      },
    ],
  },
  {
    title: 'Offboarding',
    banner: 'Remove a member cleanly',
    cues: [
      {
        id: 'c4-a',
        text: 'To remove someone, open Members and choose Remove from organization. The dialog lists the offboarding checklist before anything happens.',
      },
      {
        id: 'c4-b',
        text: "Their agents and sessions move to you, their sign-in is ended, and the organization's packs and keys come off their workstations. A report afterwards shows what each step did.",
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'Approvals, grants, audit and offboarding: each one leaves a record you can read later.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
