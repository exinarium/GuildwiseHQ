import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Interests video (slug `interests`, sidebar section 18). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Interests are topics you follow. Each one looks for new things on its own schedule, delivers what it found when you choose, and learns from your ratings.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Open Interests',
    banner: 'Your interests',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Interests in the sidebar. Each interest shows its schedule, its last run, what waits for delivery, and your ratings.',
      },
    ],
  },
  {
    title: 'A new interest and its schedules',
    banner: 'New interest',
    cues: [
      {
        id: 'c2-a',
        text: 'To follow a new topic, choose New interest. Give it a name, and describe the angle you want. The agents follow the description first.',
      },
      {
        id: 'c2-b',
        text: 'The run schedule is when it looks. The delivery schedule is when you hear about it: as one digest at set times, or as soon as a run finishes.',
      },
      {
        id: 'c2-c',
        text: 'Add a taste rule if you like, then choose Create interest.',
      },
    ],
  },
  {
    title: 'Taste rules and the quiet cap',
    banner: 'Taste and the quiet cap',
    cues: [
      {
        id: 'c3-a',
        text: 'The Taste tab keeps your explicit rules. They win over what your ratings suggest.',
      },
      {
        id: 'c3-b',
        text: 'Back on the list, the daily quiet cap limits how many digest items all interests together put on your desk in a day. Owners and Admins can change it.',
      },
    ],
  },
  {
    title: 'Deliver now',
    banner: 'Deliver now',
    cues: [
      {
        id: 'c4-a',
        text: 'This interest found three items that wait for its next delivery time. Deliver 3 now puts them on your desk straight away, within the quiet cap.',
      },
      {
        id: 'c4-b',
        text: 'They show up in the Digest tab, where you rate them.',
      },
    ],
  },
  {
    title: 'Archive and restore',
    banner: 'Archive and restore',
    cues: [
      {
        id: 'c5-a',
        text: 'An interest you no longer need is archived from More actions. It stops running and leaves the list, but nothing is lost.',
      },
      {
        id: 'c5-b',
        text: 'Tick Show archived to find it again, open it, and choose Restore.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is Interests: follow a topic, choose when you hear about it, and let your ratings sharpen it.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
