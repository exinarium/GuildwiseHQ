import type { Cue, NarratedChapter } from './types.ts';

/**
 * TEMPLATE for the voice-over of a section video: copy to `narration/<slug>.ts` (see template/slug.spec.ts).
 * Every cue is one spoken passage. `text` is what viewers read as captions; `speech` (optional) is what the voice
 * reads, for pronunciation (for example "Guildwise H Q"). Keep a passage to one or two sentences. Use the app's exact
 * labels. The cue ids are what the spec passes to `narrate(id, actions)`.
 */
export const INTRO: Cue[] = [{ id: 'intro-1', text: 'One sentence saying what this section is for.' }];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Chapter name under the video',
    banner: 'Short banner on screen',
    cues: [{ id: 'c1-a', text: 'Open Backlog in the sidebar.' }],
  },
];

export const OUTRO: Cue[] = [{ id: 'outro-1', text: 'One closing sentence.' }];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
