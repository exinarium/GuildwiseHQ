import { z } from 'zod';
import { CitationSchema } from '../research/index.ts';
import { IsoTime } from './common.ts';

/** A published research note (the note itself lives in the project's vault folder). */
export const PublicationDtoSchema = z.object({
  id: z.uuid(),
  cardId: z.uuid(),
  cardRef: z.string(),
  projectId: z.uuid(),
  projectKey: z.string(),
  vaultPath: z.string(),
  title: z.string(),
  citations: z.array(CitationSchema),
  /** First lines of the note, for the preview. */
  excerpt: z.string(),
  createdAt: IsoTime,
});
export type PublicationDto = z.infer<typeof PublicationDtoSchema>;

export const PublicationsQuerySchema = z.object({ projectId: z.uuid().optional() });
/** `GET /api/research/publications`: newest first. */
export const PublicationsResponseSchema = z.object({ publications: z.array(PublicationDtoSchema) });
