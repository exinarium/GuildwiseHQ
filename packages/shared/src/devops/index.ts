import { z } from 'zod';
import { DevOpsAccessSchema, DevOpsRequester } from '../events/devops.ts';

/**
 * DevOps shifts (docs/ARCHITECTURE.md section 16.2). A DevOps shift has no card: it works one request and ends with
 * `aom devops-done` (EnvironmentChanged) or `aom devops-approval` (DevOpsApprovalNeeded). Both are ordinary
 * terminal outcome reports with these ids.
 */
export const DEVOPS_OUTCOME_DONE = 'devops_done';
export const DEVOPS_OUTCOME_APPROVAL = 'devops_approval';

export const DevopsDoneDataSchema = z.object({
  summary: z.string().min(1).max(20000),
  commands: z.array(z.string()).default([]),
});
export type DevopsDoneData = z.infer<typeof DevopsDoneDataSchema>;

export const DevopsApprovalDataSchema = z.object({
  action: z.string().min(1).max(2000),
  reason: z.string().min(1).max(20000),
  commands: z.array(z.string()).default([]),
});
export type DevopsApprovalData = z.infer<typeof DevopsApprovalDataSchema>;

/** The `devops` part of `shift.start` for `kind: 'devops'`. */
export const DevopsShiftSchema = z.object({
  requestId: z.uuid(),
  threadId: z.uuid(),
  summary: z.string(),
  requestedBy: DevOpsRequester,
  card: z.object({ ref: z.string(), title: z.string() }).optional(),
  workstationName: z.string(),
  access: DevOpsAccessSchema,
  /** Set when the manager already approved the out-of-access action this request is resumed for. */
  approval: z
    .object({
      action: z.string(),
      reason: z.string(),
      commands: z.array(z.string()),
      note: z.string().optional(),
    })
    .optional(),
  /** Earlier messages of the request thread, oldest first. */
  history: z
    .array(z.object({ authorName: z.string(), kind: z.string(), body: z.string(), at: z.iso.datetime() }))
    .default([]),
});
export type DevopsShift = z.infer<typeof DevopsShiftSchema>;

/** Outcomes placed in the synthetic brief of a DevOps shift (the runner validates reports against them). */
export function devopsBriefOutcomes() {
  return [
    {
      id: DEVOPS_OUTCOME_DONE,
      label: 'Request completed (environment changed or nothing to change)',
      kind: 'success' as const,
      data: 'devopsDone',
    },
    {
      id: DEVOPS_OUTCOME_APPROVAL,
      label: 'Needs the manager: destructive or outside the granted access',
      kind: 'success' as const,
      data: 'devopsApproval',
    },
  ];
}

/** True when `summary` asks for something the granted `access` does not cover (used by the mock DevOps agent). */
export function needsApproval(access: z.infer<typeof DevOpsAccessSchema>, text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(sudo|delete|destroy|wipe|format|rm -rf|uninstall)\b/.test(t)) return !access.sudo;
  if (/\bdocker\b/.test(t) && /\b(install|setup|set up)\b/.test(t))
    return !(access.allowInstall && access.allowDocker);
  if (/\binstall\b/.test(t)) return !access.allowInstall;
  return false;
}
