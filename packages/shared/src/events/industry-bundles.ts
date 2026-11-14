import { z } from 'zod';
import { defineEvent, Id } from './define.ts';

/** What one bundle install created. Members that were already there are not recorded, so uninstall never touches them. */
const Items = z.object({
  rulePack: z.object({ packId: z.string().max(80), installedByBundle: z.boolean() }),
  playbooks: z
    .array(z.object({ key: z.string().max(60), scheduleId: Id, fingerprint: z.string().length(64) }))
    .max(20),
  documents: z
    .array(
      z.object({
        memberId: z.string().max(80),
        docId: Id,
        kind: z.enum(['template', 'sample']),
        tags: z.array(z.string()).max(20),
      }),
    )
    .max(100),
  journeyTemplates: z.array(z.string().max(80)).max(20),
});

export const industryBundleEvents = [
  /** An industry bundle was installed in an organization (business mode). */
  defineEvent(
    'IndustryBundleInstalled',
    z.object({
      bundleId: z.string().min(1).max(80),
      bundleVersion: z.number().int().positive(),
      items: Items,
    }),
  ),
  /** An industry bundle was removed: what was removed, and what was kept because the organization changed it. */
  defineEvent(
    'IndustryBundleRemoved',
    z.object({
      bundleId: z.string().min(1).max(80),
      removed: z.object({
        ruleEntries: z.array(Id).max(200),
        schedules: z.array(Id).max(20),
        documents: z.array(Id).max(100),
      }),
      kept: z
        .array(z.object({ kind: z.string(), id: Id }))
        .max(300)
        .default([]),
    }),
  ),
] as const;
