import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Help video (slug `help`, sidebar section 23): the Help centre. */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Help is at the bottom of the sidebar. It has the articles, the glossary, the blog, and a way to reach a person.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Search the articles',
    banner: 'Search the help',
    cues: [
      {
        id: 'c1-a',
        text: 'Type in Search the help articles to find an answer. Here, budget finds the articles and glossary words that mention it.',
      },
      { id: 'c1-b', text: 'Open a result to read the article, with its sections listed on the right.' },
    ],
  },
  {
    title: 'Glossary, what’s new and the blog',
    banner: 'Glossary, what’s new and the blog',
    cues: [
      {
        id: 'c2-a',
        text: 'The Glossary explains the words of Guildwise HQ, from allow-list to workstation.',
        speech: 'The Glossary explains the words of Guildwise H Q, from allow-list to workstation.',
      },
      { id: 'c2-b', text: 'What’s new lists the latest changes, newest first.' },
      { id: 'c2-c', text: 'And the Blog tab has articles from the team on AI agents and automation.' },
    ],
  },
  {
    title: 'Contact us and My requests',
    banner: 'Contact us and My requests',
    cues: [
      {
        id: 'c3-a',
        text: 'When the articles are not enough, Contact us sends a question, a problem or an idea to the Guildwise team.',
      },
      {
        id: 'c3-b',
        text: 'My requests keeps everything you sent, with the answers. A new reply is marked, so you do not miss it.',
      },
    ],
  },
  {
    title: 'Page help and the tour',
    banner: 'Page help and the tour',
    cues: [
      {
        id: 'c4-a',
        text: 'On any page, the question mark in the top bar explains what is on the page behind it.',
      },
      {
        id: 'c4-b',
        text: 'And on the Help centre, you can take or replay the guided tour of the sidebar at any time.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is Help. Search first, and write to us when you need a person.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
