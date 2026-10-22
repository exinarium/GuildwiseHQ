import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Platform area video (slug `platform-area`): the platform administrator's own shell. */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'The platform area is for the people who run Guildwise HQ itself. A platform administrator signs in with two-factor login and sees this separate menu.',
    speech:
      'The platform area is for the people who run Guildwise H Q itself. A platform administrator signs in with two-factor login and sees this separate menu.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Organizations',
    banner: 'Organizations',
    cues: [
      {
        id: 'c1-a',
        text: 'Organizations lists every customer, with its plan and status. You see metadata, never their work.',
      },
      {
        id: 'c1-b',
        text: 'Open one for its overview, its plan, limits and features, and its recent activity.',
      },
    ],
  },
  {
    title: 'Invitations',
    banner: 'Invitations',
    cues: [
      {
        id: 'c2-a',
        text: 'Invitations starts a new organization: enter the owner’s email and the organization name, and they become its Owner when they accept.',
      },
    ],
  },
  {
    title: 'Accounts',
    banner: 'Accounts',
    cues: [{ id: 'c3-a', text: 'Accounts lists everyone with an account, in every organization.' }],
  },
  {
    title: 'Billing',
    banner: 'Billing',
    cues: [
      {
        id: 'c4-a',
        text: 'Billing holds the payment provider, the plans and their prices, the add-ons, VAT and the invoice details.',
      },
    ],
  },
  {
    title: 'Support and Blog',
    banner: 'Support and Blog',
    cues: [
      {
        id: 'c5-a',
        text: 'Support is the inbox of every Contact us request. Your reply is emailed, and shows under the person’s My requests.',
      },
      {
        id: 'c5-b',
        text: 'Blog is where new posts wait for your review before they are published.',
      },
    ],
  },
  {
    title: 'Keys, runners, team and mail',
    banner: 'API keys, Runners, Platform team, Inbound mail',
    cues: [
      { id: 'c6-a', text: 'API keys are for the agent API. A key is stored hashed, and shown only once.' },
      {
        id: 'c6-b',
        text: 'Runners shows the runner version this server offers. Workstations check once a day and update themselves.',
      },
      {
        id: 'c6-c',
        text: 'Platform team names the organization that fixes Guildwise itself. And Inbound mail sets up the provider for the mail that organizations receive.',
      },
    ],
  },
  {
    title: 'Audit log',
    banner: 'Audit log',
    cues: [
      {
        id: 'c7-a',
        text: 'Finally, the Audit log records every platform administrator action, and is kept forever.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is the platform area: customers, money, support and the running system, kept apart from the work of each organization.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
