import { z } from 'zod';

/** Features an organization can have switched on or off (docs/design/organizations.md section 7.5). */
export const ORG_FEATURES = [
  'interests',
  'integrations',
  'outbound',
  'research',
  'phases',
  'browserTools',
  'customRoles',
] as const;
export const OrgFeatureSchema = z.enum(ORG_FEATURES);
export type OrgFeature = z.infer<typeof OrgFeatureSchema>;

export type OrgFeatureFlags = Record<OrgFeature, boolean>;

/** The four limits an organization can have; `null` is unlimited. */
export const OrgLimitsSchema = z.object({
  maxMembers: z.number().int().min(1).nullable(),
  maxWorkstations: z.number().int().min(0).nullable(),
  maxAgents: z.number().int().min(0).nullable(),
  maxProjects: z.number().int().min(0).nullable(),
});
export type OrgLimits = z.infer<typeof OrgLimitsSchema>;
export const NO_LIMITS: OrgLimits = {
  maxMembers: null,
  maxWorkstations: null,
  maxAgents: null,
  maxProjects: null,
};

export interface PlanDefinition {
  name: string;
  description: string;
  limits: OrgLimits;
  features: OrgFeatureFlags;
}

const allOn = (): OrgFeatureFlags =>
  Object.fromEntries(ORG_FEATURES.map((f) => [f, true])) as OrgFeatureFlags;

/**
 * The plan catalogue. Owner decision 8 (2026-10-06): one "Founding" plan with no limits for now. The limit fields exist
 * on every organization and stay empty (unlimited) until pricing is decided; the trial and Team presets are not created.
 */
export const PLANS = {
  founding: {
    name: 'Founding',
    description: 'The founding plan: every feature, no limits.',
    limits: NO_LIMITS,
    features: allOn(),
  },
} as const satisfies Record<string, PlanDefinition>;

export type PlanKey = keyof typeof PLANS;
export const DEFAULT_PLAN: PlanKey = 'founding';
export const PLAN_KEYS = Object.keys(PLANS) as PlanKey[];

export const isPlanKey = (k: string): k is PlanKey => k in PLANS;

export function planDefinition(key: string): PlanDefinition {
  return isPlanKey(key) ? PLANS[key] : PLANS[DEFAULT_PLAN];
}

/** Plan defaults with the organization's overrides applied (`null` or missing = plan default). */
export function effectiveFeatures(
  plan: string,
  overrides: Record<string, boolean | null | undefined> | null | undefined,
): OrgFeatureFlags {
  const base = { ...planDefinition(plan).features };
  for (const f of ORG_FEATURES) {
    const o = overrides?.[f];
    if (typeof o === 'boolean') base[f] = o;
  }
  return base;
}
