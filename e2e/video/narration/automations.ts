import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Automations video (slug `automations`, sidebar section 7, nav id `schedules`). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Automations do routine work for you. Each one has a trigger, when it runs, and an action, what it does.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Your automations',
    banner: 'Your automations',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Automations in the sidebar. Each automation shows its trigger, the next run and the last run, grouped by project.',
      },
    ],
  },
  {
    title: 'New automation: When',
    banner: 'When should it run?',
    cues: [
      {
        id: 'c2-a',
        text: 'New automation opens a wizard in three steps: When, What and Details.',
      },
      {
        id: 'c2-b',
        text: 'When can be a time, something that happens in a project, an incoming ticket or e-mail, or only when you run it. Here: on a schedule, weekdays at seven in the morning.',
      },
    ],
  },
  {
    title: 'What and Details',
    banner: 'What it does',
    cues: [
      {
        id: 'c3-a',
        text: 'What is the action. Create a card is the most common; it can also ask DevOps, ask the CEO, send a webhook or e-mail a digest.',
      },
      {
        id: 'c3-b',
        text: 'Details names the automation and fills in the card it creates: the project and the title.',
      },
    ],
  },
  {
    title: 'Run now, History and Pause',
    banner: 'Run, check, pause',
    cues: [
      {
        id: 'c4-a',
        text: 'Create automation saves it. Run now runs it once, straight away: here it creates the card at once.',
      },
      {
        id: 'c4-b',
        text: 'History lists every run: what triggered it, on schedule or by hand, and what it did.',
      },
      {
        id: 'c4-c',
        text: 'Pause switches an automation off without deleting it. Resume turns it back on.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is Automations. Set up the routine once, and let it run.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
