import { z } from 'zod';

export const SETUP_STEP_IDS = ['project', 'repository', 'workstation', 'team', 'ba', 'ceo'] as const;
export const SetupStepId = z.enum(SETUP_STEP_IDS);
export type SetupStepId = z.infer<typeof SetupStepId>;

/** The roles the "hire your team" step wants (DevOps comes with the workstation). */
export const SETUP_TEAM_ROLES = ['ba', 'builder', 'reviewer', 'tester'] as const;

export const SetupStepSchema = z.object({
  id: SetupStepId,
  title: z.string(),
  hint: z.string(),
  done: z.boolean(),
  /** The viewer may do this step (Members cannot create projects or add repositories). Read-only when false. */
  actionable: z.boolean(),
  /** Where the step is done: a path with the form opened where one exists. Null when not actionable or nothing is left to do. */
  link: z.string().nullable(),
  /** For the team step: the roles still missing. */
  missing: z.array(z.string()).optional(),
  /** Not needed to finish the checklist (the CEO step): shown for Owners and Admins, never counted. */
  optional: z.boolean().optional(),
});
export type SetupStep = z.infer<typeof SetupStepSchema>;

/**
 * `GET /api/setup-checklist`: the "Get started" checklist of the tab's organization, computed from real state.
 * `dismissed` is the viewer's own choice (kept per user); `complete` is every step done. Guests get no steps.
 */
export const SetupChecklistSchema = z.object({
  steps: z.array(SetupStepSchema),
  doneCount: z.number().int(),
  complete: z.boolean(),
  dismissed: z.boolean(),
});
export type SetupChecklist = z.infer<typeof SetupChecklistSchema>;

export const UpdateSetupChecklistRequestSchema = z.object({ dismissed: z.boolean() });
export type UpdateSetupChecklistRequest = z.infer<typeof UpdateSetupChecklistRequestSchema>;
