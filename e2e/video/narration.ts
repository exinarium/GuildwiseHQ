/**
 * The voice-over of the getting-started video: warm, clear, second person. Every cue is one spoken passage; the
 * recording waits for the audio of a cue to finish before it moves on, and the same text becomes the WebVTT captions.
 * `speech` (when given) is what the voice reads, spelled out for pronunciation (for example "H Q"); `text` is what
 * viewers read.
 */
export interface Cue {
  id: string;
  text: string;
  speech?: string;
}

export interface NarratedChapter {
  /** The chapter name shown under the video. */
  title: string;
  /** The short on-screen banner. */
  banner: string;
  cues: Cue[];
}

export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'Hello, and welcome to Guildwise HQ. In the next few minutes I will show you how to run a small team of AI agents, from your very first project to a result you can try.',
    speech:
      'Hello, and welcome to Guildwise H Q. In the next few minutes I will show you how to run a small team of A I agents, from your very first project to a result you can try.',
  },
  {
    id: 'intro-2',
    text: 'There are five steps. You can follow along in your own account as we go.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Create your first project',
    banner: 'Step 1: create your first project',
    cues: [
      { id: 'c1-a', text: 'Step one: your first project. Open Projects, and choose New project.' },
      {
        id: 'c1-b',
        text: 'Give it a short key, like SHOP, and a name, like Web shop. The key is what you will see in front of every card number.',
      },
      {
        id: 'c1-c',
        text: 'Now tell the project where its code lives. Add a repository, give it a name, and paste in its address. Your agents work on their own copy, and a change only reaches your main code after it has been reviewed and tested.',
      },
    ],
  },
  {
    title: 'Hire your agents',
    banner: 'Step 2: hire your agents',
    cues: [
      {
        id: 'c2-a',
        text: 'Step two: hire your agents. Every agent has a role and a seniority, and the seniority decides how much they are trusted with.',
      },
      {
        id: 'c2-b',
        text: 'Start with a business analyst. Bea will turn your ideas into clear, written work.',
      },
      {
        id: 'c2-c',
        text: 'Then a builder, Ada, who writes the code. A senior reviewer, Linus, who checks it. And a tester, Tess, who tries it out.',
      },
      {
        id: 'c2-d',
        text: 'That is a small, complete team. You can hire more at any time, or change their roles later.',
      },
    ],
  },
  {
    title: 'Create cards',
    banner: 'Step 3: describe the work as a card',
    cues: [
      {
        id: 'c3-a',
        text: 'Step three: describe the work as a card. A card is one thing you would like done.',
      },
      {
        id: 'c3-b',
        text: 'Give it a title, say what you need and why, and list how you will know it is finished. The clearer the card, the better the result.',
      },
      {
        id: 'c3-c',
        text: 'When you choose Specify, the card joins the team queue, and the agents pick it up by themselves.',
      },
      {
        id: 'c3-d',
        text: 'Add as many cards as you like. Here is a second one, and now the board shows both.',
      },
    ],
  },
  {
    title: 'Talk to the business analyst',
    banner: 'Step 4: talk to your business analyst',
    cues: [
      {
        id: 'c4-a',
        text: 'Step four: talk to your business analyst. You do not need a form for everything. Open the chat, pick Bea, and ask in plain words.',
      },
      { id: 'c4-b', text: 'Let us ask what she would add to the shop next.' },
      {
        id: 'c4-c',
        text: 'And there is her answer. She suggests ideas, asks good questions, and can turn a whole conversation into cards for you.',
      },
    ],
  },
  {
    title: 'Test your running project',
    banner: 'Step 5: watch the work, then test it',
    cues: [
      {
        id: 'c5-a',
        text: 'Step five: watch the work, and test your running project. Cards move across the board as the agents plan, build, review and test.',
      },
      { id: 'c5-b', text: 'Open a card to see the plan, the conversation, and what it cost.' },
      {
        id: 'c5-c',
        text: 'When the tester runs your project, she reports what she found, and every bug becomes a new card. Your part is to try the result, and tell the team what you think.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'And that is all there is to it. Hire your team, describe the work, and watch it happen. You will find more guides in Help. Thank you for watching, and good luck with your first project.',
  },
];

/** What the recording types into the BA chat, and the answer the recording-only mock reply map gives to it. */
export const BA_QUESTION = 'What would you add to the shop next?';
export const BA_ANSWER =
  'Good question. Looking at your two cards, I would add three things next:\n\n' +
  '1. A search box, so visitors can find a product in seconds.\n' +
  '2. Customer reviews on each product page, which builds trust.\n' +
  '3. A simple order-confirmation email.\n\n' +
  'Shall I turn these into cards for the team? I would start with the search box.';

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
