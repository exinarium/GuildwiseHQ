import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Vaults video (slug `vaults`, sidebar section 20). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'A vault is a git repository of markdown notes that your agents read. Decisions and standing orders are written to it, and your workstations keep it in sync.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Open Vaults',
    banner: 'Your vaults',
    cues: [
      {
        id: 'c1-a',
        text: "Open Vaults in the sidebar. The organization vault holds your organization's knowledge and your interests. A project can have a vault of its own.",
      },
    ],
  },
  {
    title: 'Register a vault',
    banner: 'Register a vault',
    cues: [
      {
        id: 'c2-a',
        text: 'A new project starts with a local folder on one workstation. It is not synced, so back it up yourself, or give the project a git repository.',
      },
      {
        id: 'c2-b',
        text: 'Choose Register a vault, pick the project, paste the git URL and set the sync interval. Agents never see credentials: the workstation uses its own git access.',
      },
    ],
  },
  {
    title: 'The vault card and Edit',
    banner: 'The vault card',
    cues: [
      {
        id: 'c3-a',
        text: 'Each card shows the git URL, how often it syncs, and every workstation that holds a copy, with its last pull and push. Edit changes the URL or the sync interval.',
      },
    ],
  },
  {
    title: 'A paused sync',
    banner: 'Sync paused: conflict',
    cues: [
      {
        id: 'c4-a',
        text: 'When the same file changed in two places, sync pauses on that workstation and lists the conflicting files. Fix them in the clone, then choose I resolved it, resume.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is Vaults: where your agents keep what they know, in repositories you own.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
