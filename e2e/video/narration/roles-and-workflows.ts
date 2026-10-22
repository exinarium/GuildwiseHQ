import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Roles & workflows video (slug `roles-and-workflows`, sidebar section 12). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Roles and workflows define how your organization works: who may do which step, and the steps a card goes through.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Roles',
    banner: 'Roles',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Roles and workflows in the sidebar. The Roles tab lists your custom roles and the built-in ones.',
      },
      {
        id: 'c1-b',
        text: 'Built-in roles ship with the app. You can extend them with extra instructions, skills and standing orders, but their core rules stay.',
      },
    ],
  },
  {
    title: 'Workflows',
    banner: 'View and compare workflows',
    cues: [
      {
        id: 'c2-a',
        text: 'The Workflows tab lists every workflow with its versions. View shows the Code workflow as a diagram, step by step.',
      },
      {
        id: 'c2-b',
        text: 'Compare with previous lists what changed from the version before.',
      },
    ],
  },
  {
    title: 'The workflow builder',
    banner: 'Add a step',
    cues: [
      {
        id: 'c3-a',
        text: 'A custom workflow is edited in the builder. New version opens it on a copy of the current one.',
      },
      {
        id: 'c3-b',
        text: 'Add a step, name it, and choose who does it. Save draft keeps it as a draft; nothing changes until you send it for approval and approve it on the desk.',
      },
      {
        id: 'c3-c',
        text: 'Back in the list, the new draft compares against the active version.',
      },
    ],
  },
  {
    title: 'Departments',
    banner: 'Departments',
    cues: [
      {
        id: 'c4-a',
        text: 'A department groups the roles and workflows of one function. Type a name and choose Create department.',
      },
    ],
  },
  {
    title: 'Design with the BA',
    banner: 'Design with the BA',
    cues: [
      {
        id: 'c5-a',
        text: 'In Design with the BA, start a design chat and describe the role or workflow you need. The BA drafts it and puts it on your desk for approval.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is Roles and workflows: shape how your team works, one approved version at a time.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
