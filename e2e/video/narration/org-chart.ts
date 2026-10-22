import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Org chart video (slug `org-chart`, sidebar section 10). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'The org chart shows who is on the floor, whom each agent reports to, and who answers its questions.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Who reports to whom',
    banner: 'Who reports to whom',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Org chart in the sidebar. You are at the top as the manager, with your CEO and your business analyst below you, and the teams grouped by department.',
      },
      {
        id: 'c1-l',
        text: 'Each tile says in words what the agent is doing, and where it runs. The legend under the chart shows how a question climbs: to a senior of the same role, then the BA, then the CEO, and last to you, on the desk.',
      },
      {
        id: 'c1-b',
        text: 'Click an agent for its details: the projects it works on, whom it reports to and escalates to, its workstation, its spend and its recent work.',
      },
    ],
  },
  {
    title: 'Filter and switch views',
    banner: 'Filter and switch views',
    cues: [
      {
        id: 'c2-a',
        text: 'Allowed on project shows who may work one project. Agents allowed on any project always show.',
      },
      {
        id: 'c2-b',
        text: 'The View switch turns the chart into a list, grouped by department, and back.',
      },
    ],
  },
  {
    title: 'Workstations and DevOps',
    banner: 'Workstations and DevOps',
    cues: [
      {
        id: 'c3-a',
        text: 'Below the chart, Workstations and DevOps lists every machine with its own DevOps engineer. It looks after that machine and reports to your desk.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is the org chart: your whole team on one page.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
