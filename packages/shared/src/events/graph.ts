import { z } from 'zod';
import { GraphFailReasonSchema, GraphRepoKeySchema } from '../graph/index.ts';
import { defineEvent, Id } from './define.ts';

/**
 * Project graph events (docs/design/project-graphs.md sections 1 and 5). The graph itself is derived from the code and
 * lives in the project vault on the workstation; **no event carries anything derived from code**: only ids, a commit id,
 * counts, a version and fixed reason codes. Projections keep status, never content.
 */
export const graphEvents = [
  /** A full index of one repository of a project was asked for (a repository was attached, the owner asked, or a backfill). */
  defineEvent(
    'ProjectGraphRequested',
    z.object({
      projectId: Id,
      orgId: Id,
      repoId: Id,
      repoKey: GraphRepoKeySchema,
      reason: z.enum(['attached', 'manual', 'backfill', 'retry']),
    }),
  ),
  /** The workstation wrote the graph of a repository at `commit` into the project vault. */
  defineEvent(
    'ProjectGraphIndexed',
    z.object({
      projectId: Id,
      orgId: Id,
      repoId: Id,
      repoKey: GraphRepoKeySchema,
      commit: z.string().min(7).max(64),
      files: z.number().int().nonnegative(),
      nodes: z.number().int().nonnegative(),
      edges: z.number().int().nonnegative(),
      modules: z.number().int().nonnegative(),
      indexerVersion: z.string().max(40),
      durationMs: z.number().int().nonnegative(),
      workstationId: Id,
      vaultId: z.string().max(64),
    }),
  ),
  /** The workstation could not index (a fixed reason code); the server retries with a back-off. */
  defineEvent(
    'ProjectGraphFailed',
    z.object({
      projectId: Id,
      orgId: Id,
      repoId: Id,
      repoKey: GraphRepoKeySchema,
      reason: GraphFailReasonSchema,
      workstationId: Id.optional(),
    }),
  ),
] as const;
