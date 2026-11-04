import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Storage video (slug `storage`: Organization settings, Storage tab; help article `storage#connect`). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Storage is where you tell Guildwise where your client files go. Forms and journeys write them to your own storage, never to the Guildwise server.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'The Storage tab',
    banner: 'Storage',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Organization, then the Storage tab. Nothing is connected yet. A form that collects documents cannot be published until it has a storage connection to write to.',
      },
    ],
  },
  {
    title: 'Add and connect a folder',
    banner: 'Add storage',
    cues: [
      {
        id: 'c2-a',
        text: 'Choose Add storage. Give the connection a display name, pick the type, and choose one of your online workstations. Here we use a folder on this workstation.',
      },
      {
        id: 'c2-b',
        text: 'Enter the folder path and choose Connect. The path is sealed in your browser for the workstation. The server only keeps the name, the type and the health.',
      },
    ],
  },
  {
    title: 'Test and rename',
    banner: 'Test connection',
    cues: [
      {
        id: 'c3-a',
        text: 'The row shows Connected. Test connection asks the workstation to write a small file and delete it again, and tells you whether it worked.',
      },
      {
        id: 'c3-b',
        text: 'Rename changes the display name, and the connection keeps working. If a connection ever shows Needs re-authentication, use Reconnect. Remove deletes it from the workstation; files already written stay.',
      },
    ],
  },
  {
    title: 'The other kinds',
    banner: 'Other types',
    cues: [
      {
        id: 'c4-a',
        text: 'The Type list also offers OneDrive, Google Drive, S3-compatible storage and a folder in a vault. For OneDrive and Google Drive you sign in with a code. The sign-in stays on your workstation.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is Storage: your own place for client files, connected once and used by your forms and journeys.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
