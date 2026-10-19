import { z } from 'zod';
import { GraphFailReasonSchema } from '../graph/index.ts';
import { IsoTime } from './common.ts';

/**
 * `GET /api/projects/:id/graph`: the STATUS of a project's code graph (docs/design/project-graphs.md owner decision 5).
 * There is no graph view and nothing derived from code: only the indexed commit, counts, the indexer version and timings.
 */
export const ProjectGraphRepoStatusSchema = z.object({
  repoId: z.uuid(),
  repoName: z.string(),
  status: z.enum(['none', 'requested', 'indexed', 'failed']),
  commit: z.string().nullable(),
  files: z.number().int(),
  nodes: z.number().int(),
  edges: z.number().int(),
  modules: z.number().int(),
  indexerVersion: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  indexedAt: IsoTime.nullable(),
  failReason: GraphFailReasonSchema.nullable(),
});
export type ProjectGraphRepoStatus = z.infer<typeof ProjectGraphRepoStatusSchema>;

export const ProjectGraphStatusSchema = z.object({
  /** `projectGraphs.enabled` of this server. */
  enabled: z.boolean(),
  /** Where the graph is kept: the project vault (`local`: a folder on one workstation, not synced; `git`: synced). */
  vault: z.object({ storage: z.enum(['git', 'local']), kind: z.enum(['org', 'project']) }).nullable(),
  repos: z.array(ProjectGraphRepoStatusSchema),
});
export type ProjectGraphStatus = z.infer<typeof ProjectGraphStatusSchema>;
