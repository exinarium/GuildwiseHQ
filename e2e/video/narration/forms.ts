import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Forms video (slug `forms`, sidebar entry Forms; help article `forms#build-a-form`). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Forms lets you build a form once, share it with a link or a QR code, and have the answers and documents arrive in your own storage.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Build a form',
    banner: 'Build',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Forms in the sidebar. Each form shows its fields and its latest version. Open one to edit it.',
      },
      {
        id: 'c1-b',
        text: 'The palette on the left lists the field types. Choose one to add it after the selected field. Select any field to change its label, whether it is required, and its other properties on the right.',
      },
      {
        id: 'c1-c',
        text: 'Choose Save. Every save is a new version, and the Versions menu lets you look at an earlier one.',
      },
    ],
  },
  {
    title: 'Preview',
    banner: 'Preview',
    cues: [
      {
        id: 'c2-a',
        text: 'Preview shows the form as a client sees it, on a desktop or on a phone.',
      },
    ],
  },
  {
    title: 'Share the form',
    banner: 'Share',
    cues: [
      {
        id: 'c3-a',
        text: 'The Share tab holds the public address and its QR code. You changed the form after publishing it, so choose Publish changes to put the new version live. The address stays the same.',
      },
      {
        id: 'c3-b',
        text: 'This is what a client sees when they open the address. Their answers and files go straight to your storage.',
      },
    ],
  },
  {
    title: 'Personal links and submissions',
    banner: 'Personal links',
    cues: [
      {
        id: 'c4-a',
        text: 'A personal link is made for one client. Enter a client or file reference, not a name, choose when it expires, and create it. You can copy it, show its QR code, or revoke it.',
      },
      {
        id: 'c4-b',
        text: 'Submissions lists what has arrived, with its status and where the files were saved. The answers themselves stay in your storage.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is Forms: build it, share it, and collect answers and documents in your own storage.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
