import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Documents video (slug `documents`). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Documents is the shelf for everything your discovery and boardroom sessions write: product briefs, PRDs and minutes. Nothing is lost, and every change is kept as a version.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Find a document',
    banner: 'Briefs, PRDs and minutes',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Documents in the sidebar. The newest document comes first. Each row shows the kind, the status, the version and how long ago it changed.',
      },
      {
        id: 'c1-b',
        text: 'The first row of chips filters by kind. Pick PRD to see only the product requirement documents.',
      },
      {
        id: 'c1-c',
        text: 'The second row filters by status. Draft, In review, Approved, Handed to the BA and Archived.',
      },
    ],
  },
  {
    title: 'Read and approve',
    banner: 'Versions and approval',
    cues: [
      {
        id: 'c2-a',
        text: 'Open a document to read it. The version picker lets you read any earlier version.',
      },
      {
        id: 'c2-b',
        text: 'An Owner or Admin can approve it here. Approved documents are copied to your vault, so agents can find them later.',
      },
      {
        id: 'c2-c',
        text: 'Reopen turns an approved document back into a draft, and when a document came from a session, a link at the bottom takes you back to it.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is Documents: every brief, PRD and set of minutes in one place, with its history.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
