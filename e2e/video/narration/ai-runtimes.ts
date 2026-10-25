import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the AI runtimes video (slug `ai-runtimes`): Integrations, AI runtime, and Settings, Model providers. */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Agents run on an AI runtime: Claude Code, Codex, the Gemini CLI, or a model provider you reach with a key. This video shows where you set them up, and how you keep their cost under control.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'What a workstation can run',
    banner: 'The AI runtime tiles',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Integrations in the sidebar and pick your workstation. Under AI runtime there is one tile for each program and provider.',
      },
      {
        id: 'c1-b',
        text: 'A tile says whether the program is installed, with the command to install it if it is not, who is signed in, and whether a key is set and whose key is in effect.',
      },
      {
        id: 'c1-c',
        text: "Sign in runs the program's own login on the workstation. Open the link, enter the code, and the account shows Signed in.",
      },
    ],
  },
  {
    title: 'Keys and named accounts',
    banner: 'Set a key, add an account',
    cues: [
      {
        id: 'c2-a',
        text: 'For an API provider, click Set key. The key is encrypted in your browser for this workstation, and only its runner keeps it.',
      },
      {
        id: 'c2-b',
        text: 'Every runtime has one main account, and any number of named accounts. Click Add a named account, give it a short name such as work, and set its key.',
      },
      {
        id: 'c2-c',
        text: 'Make main swaps a named account with the main one. Nothing is lost, and doing it again undoes it. A project picks its account in its own settings.',
      },
      {
        id: 'c2-d',
        text: 'Allow projects to use my accounts decides whether projects you are not a member of may spend your named accounts. It is off by default.',
      },
    ],
  },
  {
    title: 'Organization keys',
    banner: 'Settings, Model providers',
    cues: [
      {
        id: 'c3-a',
        text: 'For keys the whole organization shares, follow the link to Settings, Model providers. Owners and Admins set the key once, and choose which workstations get it.',
      },
      {
        id: 'c3-b',
        text: 'Each provider has a monthly cap. You are warned at eighty percent and again at one hundred, and at the cap new runs on the organization key are refused until you raise it.',
      },
      {
        id: 'c3-c',
        text: 'A workstation that joined later shows Not shared. Share it from a workstation that has the key, without typing the key again. A workstation with a key of its own uses that one instead, and it is not capped. Revoke removes the key everywhere.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'Keys never leave your browser unencrypted, and a named account is your own key, so it is never capped.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
