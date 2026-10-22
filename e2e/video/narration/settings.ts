import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Settings video (slug `settings`, sidebar section 21). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Settings holds what is personal to your account: your picture, how you sign in, what you hear from us, and your time zone.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Your picture',
    banner: 'Your picture',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Settings in the sidebar. Change picture lets you pick a cartoon face, take a photo, or upload an image. It shows in the sidebar and on the answers you give at the desk.',
      },
    ],
  },
  {
    title: 'Two-factor login',
    banner: 'Two-factor login',
    cues: [
      {
        id: 'c2-a',
        text: 'Two-factor login asks for a six-digit code from your authenticator app after your password. Set up walks you through it.',
      },
    ],
  },
  {
    title: 'Expert mode for code changes',
    banner: 'Expert mode',
    cues: [
      {
        id: 'c3-a',
        text: 'Expert mode for code changes is off by default. Guildwise then describes code work in plain terms and takes care of branches. Tick it to see branch names and the git controls.',
      },
    ],
  },
  {
    title: 'Briefing, notifications and the blog digest',
    banner: 'What you hear from us',
    cues: [
      {
        id: 'c4-a',
        text: 'The Monday briefing is one email a week with what was finished, what waits on you, and what is blocked.',
      },
      {
        id: 'c4-b',
        text: 'Notifications send a push to your phone or computer when something needs you, once push is set up on the server.',
      },
      {
        id: 'c4-c',
        text: 'And the weekly blog digest brings the new articles from the Guildwise blog.',
      },
    ],
  },
  {
    title: 'Your time zone',
    banner: 'Your time zone',
    cues: [
      {
        id: 'c5-a',
        text: "Last, your time zone. Your CEO's daily report is written on your clock.",
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is Settings. Everything here is yours alone; what the whole organization shares lives elsewhere.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
