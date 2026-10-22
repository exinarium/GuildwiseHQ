import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the CEO video (slug `ceo`, sidebar section 11). The demo CEO is called Ada. */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Every organization has a built-in CEO agent. It stands in for you: it works the desk and the floor inside the limits you set, and only what it cannot decide comes to you.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Overview',
    banner: 'Overview',
    cues: [
      {
        id: 'c1-a',
        text: 'Open CEO in the sidebar. The Overview shows its state, the workstation it runs on, its spend, and how many of its decisions you undid this week. Pause is the emergency stop.',
      },
    ],
  },
  {
    title: 'Authority',
    banner: 'What the CEO may decide',
    cues: [
      {
        id: 'c2-a',
        text: 'Authority sets, for every kind of action, whether the CEO decides it, only recommends it, or never does it.',
      },
      {
        id: 'c2-b',
        text: 'By default it decides card work itself: it can move a card to another stage, raise the model for one card, and send a card with a failed test back to the tester.',
      },
      {
        id: 'c2-c',
        text: 'Under Items on the desk, questions, stop-losses and loops are set to Decide, so the CEO settles them without asking you. Persona, Memory and Topics shape how it thinks; see the guide.',
      },
    ],
  },
  {
    title: 'Reporting and alerts',
    banner: 'Reporting and alerts',
    cues: [
      {
        id: 'c3-a',
        text: 'Reporting and alerts sets the time of the daily report, which news reaches you by which channel, and your quiet hours.',
      },
    ],
  },
  {
    title: 'Ask the CEO',
    banner: 'Ask Ada',
    cues: [
      {
        id: 'c4-a',
        text: 'Ask Ada, in the top bar, opens your chat with the CEO. Type a question and press Enter.',
      },
      {
        id: 'c4-b',
        text: 'New chat starts a clean conversation. The earlier chats stay in the list on the left.',
      },
    ],
  },
  {
    title: 'Activity log and Undo',
    banner: 'Activity log and Undo',
    cues: [
      {
        id: 'c5-a',
        text: "Back on the CEO page, the Activity log lists everything the CEO decided, recommended or refused, with its reason and confidence. Here it paused Ben, changed a priority, moved a card and raised a card's model.",
      },
      {
        id: 'c5-b',
        text: 'Undo reverses an action where that is possible. Ada is told, and learns from your choice.',
      },
    ],
  },
  {
    title: 'Workstations',
    banner: 'Where the CEO runs',
    cues: [
      {
        id: 'c6-a',
        text: 'The CEO runs on one of your own workstations. On the Workstations tab, Move the CEO here moves it to another one.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is your CEO. Set its limits once, and check its work in the activity log.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
