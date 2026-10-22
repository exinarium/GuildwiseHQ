import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Workstations video (slug `workstations`, sidebar section 13). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'A workstation is a computer of yours that runs your agents. Every shift an agent works happens on one of them.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Add a workstation',
    banner: 'Add a workstation',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Workstations in the sidebar. This organization has two: one online and one offline.',
      },
      {
        id: 'c1-b',
        text: 'To add another, choose Add a workstation. Pick where your agents should run: your own computer, a server you reach over SSH, or GitHub Codespaces.',
      },
      {
        id: 'c1-c',
        text: 'For your own computer, pick the system. The wizard shows the steps and one command to copy. Once you run it, the progress below moves on from Waiting for you to run the command, through the health checks, to Ready.',
      },
    ],
  },
  {
    title: 'Pair with a code',
    banner: 'Pair with a code',
    cues: [
      {
        id: 'c2-a',
        text: 'Already have the runner on that computer? Pair it with a code instead. Generate a one-time code and run the pair command it shows on the machine.',
      },
    ],
  },
  {
    title: 'The workstation card',
    banner: 'Health and shifts',
    cues: [
      {
        id: 'c3-a',
        text: 'Each workstation has a card. The dot shows whether it is online, and the card counts the shifts running there. Open the card for the details.',
      },
      {
        id: 'c3-b',
        text: 'Here you see its runtimes, the repositories it serves and how many shifts run now. Shifts at once sets how many it may run side by side. Git hosts lists the git accounts it pushes with, with a link to Integrations.',
      },
    ],
  },
  {
    title: 'Check for updates',
    banner: 'Check for updates',
    cues: [
      {
        id: 'c4-a',
        text: 'The runner updates itself once a day. To check now, choose Check for updates. The answer appears beside the button.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is the Workstations page: add machines, keep an eye on their health, and set how much work each one takes.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
