/** What the in-app help is made of. Articles are markdown files (articles/*.md); page help and the glossary are data. */

/** One control (or group of controls) on a page and what it does, in plain language. */
export interface PageHelpControl {
  /** The label as the user sees it on screen ("New card", "Filter by phase"). */
  name: string;
  /** One or two sentences: what it does and when to use it. */
  text: string;
}

/** The "What's on this page" panel of one route. */
export interface PageHelp {
  /** The page name as the user knows it ("Your desk"). */
  title: string;
  /** One to three sentences: what the page is for. */
  intro: string;
  /** Every control and area of the page, top to bottom. */
  controls: PageHelpControl[];
  /** Where to read more: `slug` or `slug#anchor` of an article under /help. */
  article?: string;
  /** Optional tips ("Press n anywhere to create a card"). */
  tips?: string[];
}

export interface GlossaryEntry {
  term: string;
  /** Other words people might search for. */
  aka?: string[];
  /** One to three plain sentences. */
  definition: string;
  /** `slug` or `slug#anchor` of the article that explains it fully. */
  article?: string;
}
