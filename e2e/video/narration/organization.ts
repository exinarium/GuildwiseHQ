import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Organization video (slug `organization`, sidebar section 22). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Organization is where the Owner and Admins manage who belongs to your organization, and what your plan allows.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'General and your role',
    banner: 'General',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Organization in the sidebar. General shows the name of the organization, its Owner, and your role. Here, you are the Owner.',
      },
    ],
  },
  {
    title: 'Members and inviting',
    banner: 'Members',
    cues: [
      {
        id: 'c2-a',
        text: 'Members lists everyone with their role. Admins help run the organization; Members work on the projects they are given. As the Owner, you change a role right here.',
      },
      {
        id: 'c2-b',
        text: 'To add someone, choose Invite member. Enter their email, pick the role and the projects they start on, then choose Send invitation.',
      },
    ],
  },
  {
    title: 'Invitations',
    banner: 'Invitations',
    cues: [
      {
        id: 'c3-a',
        text: 'Invitations shows who was invited and whether they joined. Resend sends the email again. Revoke makes the link in it stop working.',
      },
    ],
  },
  {
    title: 'Guests',
    banner: 'Guests',
    cues: [
      {
        id: 'c4-a',
        text: 'Guests belong to another organization and work on one of your projects. They do not count against your limits.',
      },
    ],
  },
  {
    title: 'E-mail inbox and project links',
    banner: 'Inbox and project links',
    cues: [
      {
        id: 'c5-a',
        text: 'E-mail inbox gives your organization addresses whose mail can become draft cards, once your platform administrator has connected a mail provider.',
      },
      {
        id: 'c5-b',
        text: 'Project links record how your projects depend on each other, or on something outside Guildwise.',
      },
    ],
  },
  {
    title: 'Plan and limits',
    banner: 'Plan & limits',
    cues: [
      {
        id: 'c6-a',
        text: 'Plan and limits shows your plan, what you use, and the limits that apply. The Owner also sees Billing.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is Organization: who is in, what each person may do, and what your plan allows.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
