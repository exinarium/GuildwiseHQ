import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Boardroom video (slug `boardroom`). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'A boardroom is a debate. You give it a topic, and a Chair runs a meeting in which each seat argues from its own point of view, so you hear the other side before you decide.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Set up the meeting',
    banner: 'Topic, format and cast',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Boardroom in the sidebar and click New boardroom. Write the topic, add a short brief, and choose a format. Here it is a pre-mortem.',
      },
      {
        id: 'c1-b',
        text: "The cast always has an Optimist and a Devil's Advocate. Those two seats are fixed and cannot be removed. Add three or four more: personas from the library, your own agents, or a persona cast from a one-line brief.",
      },
      {
        id: 'c1-c',
        text: 'Suggest a cast lets the Chair propose seats for the topic, and you can save a cast as a room to use again. Set a round cap, a cost limit and a time limit, then click Start.',
      },
    ],
  },
  {
    title: 'Round one is sealed',
    banner: 'Everyone answers on their own',
    cues: [
      {
        id: 'c2-a',
        text: 'The first round is sealed. Every seat answers on its own, so nobody copies anybody, and you only see how many answers are in.',
      },
      {
        id: 'c2-b',
        text: 'Then all the answers are revealed together. The sticky notes the seats add collect on the whiteboard: ideas, risks and decisions.',
      },
    ],
  },
  {
    title: 'Decide and steer',
    banner: 'The Chair asks you',
    cues: [
      {
        id: 'c3-a',
        text: 'When only you can decide, the Chair pauses and asks. Type an at sign and a name to make a seat speak first in the next round, choose an option, and click Decide.',
      },
      {
        id: 'c3-b',
        text: 'The whiteboard is yours too. Add a note, vote for one, and move it to another column.',
      },
    ],
  },
  {
    title: 'Minutes and PRD',
    banner: 'End the session',
    cues: [
      {
        id: 'c4-a',
        text: 'When you have heard enough, click End session. The Chair writes the minutes: the positions, the disagreements that stayed open, and the whiteboard.',
      },
      {
        id: 'c4-b',
        text: 'Pull into PRD starts a discovery session that already knows what the boardroom concluded. The minutes are also kept under Documents.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'A boardroom costs what its turns cost, and the meters show it as you go. Pause or end it whenever you like.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
