import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Metrics video (slug `metrics`, sidebar section 16). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Metrics shows what your team delivered, where work waited on you, and where quality slipped.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Range and project',
    banner: 'Choose a range and a project',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Metrics in the sidebar. Pick a range of seven, fourteen, thirty or ninety days, and narrow it to one project, or keep all projects.',
      },
    ],
  },
  {
    title: 'Throughput and time blocked',
    banner: 'Throughput and time blocked',
    cues: [
      {
        id: 'c2-a',
        text: 'Throughput counts the cards finished per day. Time blocked on you adds up how long cards waited for your answer, and how many cards were held up. Answer your Desk quickly, and this number stays small.',
      },
    ],
  },
  {
    title: 'Bounce rate and bugs',
    banner: 'Bounce rate and bugs',
    cues: [
      {
        id: 'c3-a',
        text: 'Bounce rate per builder shows how often a builder’s work came back from review or failed its test. Bugs escaped past test counts the failed test runs per day. A high rate often means the briefs need more detail.',
      },
    ],
  },
  {
    title: 'Duration and queues',
    banner: 'Duration and queues',
    cues: [
      {
        id: 'c4-a',
        text: 'Duration shows how long a card takes from start to finish, and the shift time of each agent. Queue depth per column shows where cards are waiting right now. A long bar means work is piling up in that column.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'The numbers come from what really happened on your boards. Check Metrics now and then to see where your team flows, and where it waits.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
