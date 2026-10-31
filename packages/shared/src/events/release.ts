import { z } from 'zod';
import { ComponentBumpSchema } from '../release/dto.ts';
import { defineEvent, Id } from './define.ts';

const Level = z.enum(['patch', 'minor', 'major']);

export const releaseEvents = [
  /** A "Ship release" proposal was prepared for a repository (desk item created). */
  defineEvent(
    'ReleaseProposed',
    z.object({
      proposalId: Id,
      projectId: Id,
      repoId: Id,
      deskItemId: Id,
      trigger: z.enum(['release_pr', 'ahead', 'manual']),
      recommendedVersion: z.string(),
      level: Level,
      reason: z.string(),
      lastTag: z.string().nullable(),
      headSha: z.string(),
    }),
  ),
  /** The owner approved a release: the contract the release commit step reads. */
  defineEvent(
    'ReleaseApproved',
    z.object({
      proposalId: Id,
      projectId: Id,
      repoId: Id,
      deskItemId: Id,
      version: z.string(),
      lastTag: z.string().nullable(),
      headSha: z.string(),
      components: z.array(ComponentBumpSchema.omit({ under: true, versionFile: true, message: true })),
      /** The section body as it will read (intro and entries), without the heading. */
      notes: z.string(),
      notesSource: z.enum(['changelog', 'commits']),
      approvedBy: Id,
    }),
  ),
  defineEvent(
    'ReleaseProposalClosed',
    z.object({
      proposalId: Id,
      repoId: Id,
      reason: z.enum(['dismissed', 'rejected', 'released', 'nothing_to_release']),
      tag: z.string().optional(),
    }),
  ),
] as const;
