import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Agents video (slug `agents`, sidebar section 9). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'The Agents page is your team. Every agent has a card with its role, model, current work and how it performs against the others in its role.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Hire an agent',
    banner: 'Hire an agent',
    cues: [
      { id: 'c1-a', text: 'Open Agents in the sidebar, then choose Hire agent.' },
      {
        id: 'c1-b',
        text: 'Pick the role and the seniority. The runtime and the effort come from the role, and you can change them here.',
      },
      {
        id: 'c1-c',
        text: 'Under Where may this agent work, tick the projects it is allowed on. Give it a name, and Hire. It appears on the page at once.',
      },
    ],
  },
  {
    title: 'Pause, resume and change model',
    banner: 'Pause and change model',
    cues: [
      {
        id: 'c2-a',
        text: 'Pause stops an agent from taking new work; a running shift still finishes. Resume puts it back to work.',
      },
      {
        id: 'c2-b',
        text: 'Change model switches an agent to another model or effort. It applies from its next shift, and the agent keeps its name and history.',
      },
    ],
  },
  {
    title: 'Recommendations',
    banner: 'Act on a recommendation',
    cues: [
      {
        id: 'c3-a',
        text: 'Recommendations are rule-based suggestions with their evidence. Here two builders have been idle for ten days while the queue is empty.',
      },
      {
        id: 'c3-b',
        text: 'Apply one with its button: Fire retires Cleo, and the card says what was done.',
      },
      {
        id: 'c3-c',
        text: 'Dismiss the other if you disagree. It will not be suggested again for thirty days. With several open, Dismiss all clears them in one go.',
      },
    ],
  },
  {
    title: 'Filter by project',
    banner: 'Filter by project',
    cues: [
      {
        id: 'c4-a',
        text: 'The Project filter shows only the agents allowed on one project, and the Department filter does the same for a department.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is the Agents page. Hire the team you need, and keep it tuned with the recommendations.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
