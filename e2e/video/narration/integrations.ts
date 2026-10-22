import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Integrations video (slug `integrations`, sidebar section 15). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Integrations are the logins and tokens a workstation uses: Claude Code, your git hosts, Jira and MCP servers. They are stored on the workstation itself, never on our server.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Choose the workstation',
    banner: 'Choose the workstation',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Integrations in the sidebar. With more than one workstation, you first choose which one. A badge says when something there needs attention.',
      },
    ],
  },
  {
    title: 'Claude Code accounts',
    banner: 'Claude Code accounts',
    cues: [
      {
        id: 'c2-a',
        text: 'Each Claude Code account has its own tile. The main account is the one Claude Code itself is signed in with. A second account, here called work, spreads the usage.',
      },
      {
        id: 'c2-b',
        text: 'A tile shows the account, how it signed in and when it was last checked. Test checks the login again, and Remove deletes it from the workstation.',
      },
      {
        id: 'c2-c',
        text: 'To add one, choose Connect another account. Name it, pick how you want to connect, and Start sign-in. We will cancel here.',
      },
    ],
  },
  {
    title: 'Git hosts and Jira',
    banner: 'Git hosts and Jira',
    cues: [
      {
        id: 'c3-a',
        text: 'Git hosts let the agents push branches and open pull requests. The GitHub tile shows the account and the scopes its token has.',
      },
      {
        id: 'c3-b',
        text: 'The Jira tile connects your tracker, so agents can read the tickets and attachments behind a card.',
      },
    ],
  },
  {
    title: 'MCP servers',
    banner: 'Sign in to MCP servers',
    cues: [
      {
        id: 'c4-a',
        text: 'MCP servers come with Claude Code plugins. A server that needs a sign-in shows Sign in, which starts the sign-in in your browser.',
      },
      {
        id: 'c4-b',
        text: 'A server you are signed in to shows Sign out. It asks first, because the sign-in is shared by every pairing on that machine.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is the Integrations page: every login of a workstation in one place, tested and changed from here.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
