import { z } from 'zod';

/** `GET/PUT /api/me/weekly-briefing`: the person's choice about the Monday briefing mail (default on). */
export const BriefingPreferenceSchema = z.object({ enabled: z.boolean() });
export type BriefingPreference = z.infer<typeof BriefingPreferenceSchema>;
