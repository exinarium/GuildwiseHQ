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
  /** The release commit was queued on a workstation (on approval, or on Retry). */
  defineEvent(
    'ReleaseShipStarted',
    z.object({
      shipId: Id,
      proposalId: Id,
      repoId: Id,
      version: z.string(),
      tag: z.string(),
      date: z.string(),
      workstationId: Id,
      retry: z.boolean(),
      /** The command payload without the commit identity. */
      payload: z.record(z.string(), z.unknown()),
    }),
  ),
  /** The release commit is on the working branch (made now, resumed, or already there). */
  defineEvent(
    'ReleaseCommitted',
    z.object({
      shipId: Id,
      commit: z.string(),
      alreadyDone: z.boolean(),
      resumed: z.boolean(),
      signedOff: z.boolean(),
      components: z.array(
        z.object({
          name: z.string(),
          state: z.string(),
          from: z.string().nullable(),
          to: z.string().nullable(),
        }),
      ),
    }),
  ),
  /** A step of the release stopped; `step` is free text so later steps (tag, publish) can use the event too. */
  defineEvent(
    'ReleaseFailed',
    z.object({
      shipId: Id,
      step: z.string(),
      error: z.string(),
      alertDeskItemId: Id.optional(),
    }),
  ),
] as const;
