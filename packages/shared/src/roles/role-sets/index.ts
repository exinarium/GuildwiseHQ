import { BMAD_ROLE_SET } from './bmad.ts';

export { BMAD_METHODS, BMAD_PERSONAS, BMAD_SOURCE } from './bmad.generated.ts';
export * from './bmad.ts';
export type { BmadMethodSection, BmadPersona } from './bmad-types.ts';

/**
 * The role sets an organization can run: `guildwise`, the stock roles, or `bmad`, the built-in roles with the BMAD Method's
 * personas and skills (docs/bmad-roles.md).
 */
export const ROLE_SETS = ['guildwise', BMAD_ROLE_SET] as const;
export type RoleSetKey = (typeof ROLE_SETS)[number];
