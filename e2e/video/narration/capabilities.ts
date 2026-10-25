import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Capabilities video (slug `capabilities`). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Capabilities are what your agents can use beyond their role: skills, personas and playbooks. This is their registry, and the place to add more, safely.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'The registry',
    banner: 'Skills, personas and playbooks',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Capabilities in the sidebar. The Registry lists every skill, persona and playbook, and where each one comes from: built in, a vault, a project, or a pack.',
      },
      {
        id: 'c1-b',
        text: 'Search by name, or filter by kind and by source. A pack item says if it needs approval before it can be used.',
      },
      {
        id: 'c1-c',
        text: 'The Starter gallery has a few to try first. Run it starts a guided session on a playbook. Hire it opens a review of a persona, and nothing is hired until you press Hire.',
      },
    ],
  },
  {
    title: 'Packs and trust',
    banner: 'Add a pack, then approve it',
    cues: [
      {
        id: 'c2-a',
        text: 'A pack brings more from a git repository. On Packs, click Add a pack by git URL, give the URL and a tag, and choose the workstation that reads it. A private repository takes a deploy key or a token, sealed in your browser.',
      },
      {
        id: 'c2-b',
        text: 'A new pack starts untrusted: nothing of it is used. Review and approve shows its files, flags any scripts, and approves that exact commit.',
      },
      {
        id: 'c2-c',
        text: 'Scripts stay off unless you switch them on. Once a pack is approved, Hire from this pack turns a persona into an agent, and Check for updates shows what changed before you accept it.',
      },
    ],
  },
  {
    title: 'Write your own',
    banner: 'My capabilities',
    cues: [
      {
        id: 'c3-a',
        text: 'Under My capabilities you write your own: click New pack, then Start writing. A pack can be private to your workstation, so only you see it, or shared with the organization after an Owner or Admin approves it.',
      },
      {
        id: 'c3-b',
        text: 'Add a skill, a persona or a playbook. The editor checks your work as you type, and Save to workstation keeps the pack there. Export as zip gives a folder you can push to git.',
      },
    ],
  },
  {
    title: 'Project skills and grants',
    banner: 'Reviewed before used',
    cues: [
      {
        id: 'c4-a',
        text: 'Project skills lists the skills found in your project repositories. Nothing found there is used until an Owner or Admin has read it and marked it reviewed. Block keeps one out for good.',
      },
      {
        id: 'c4-b',
        text: 'Skill grants shows which skills each role has, resolved against the registry.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'Agents only ever use what you have approved, and a changed file always needs a new review.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
