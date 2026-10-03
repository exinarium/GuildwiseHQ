import { z } from 'zod';
import { CitationSchema } from '../research/index.ts';
import { defineEvent, Id } from './define.ts';

/** Research events (docs/ARCHITECTURE.md section 5.2, M6). */
export const researchEvents = [
  /**
   * The checker verified every claim and the note was written into the vault (by the checker's runner, committed and
   * pushed by vault sync). The event carries the path and the citations only.
   */
  defineEvent(
    'ResearchPublished',
    z.object({
      cardId: Id,
      projectId: Id,
      vaultPath: z.string().min(1),
      title: z.string().min(1),
      citations: z.array(CitationSchema).min(1),
      /** First lines of the note, for the card page (the site holds no vault content). */
      excerpt: z.string().default(''),
    }),
  ),
] as const;
