import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { type RoleDefinition, RoleDefinitionSchema } from '../roles/schema.ts';
import { type WorkflowDefinition, WorkflowDefinitionSchema } from '../workflows/schema.ts';

/**
 * Definition files (docs/SPEC.md "Expanding the organization"): approved roles and workflows are kept in the owner's
 * vault as provider-neutral YAML, one file per version, with a copy registered on the site so the dispatcher can
 * route by them. Nothing in a file names an agent runtime; the format is versioned so later changes can be migrated.
 */
export const DEFINITION_FORMAT = 'aom-definition/1';

export type DefinitionKind = 'role' | 'workflow';

export const DefinitionFileSchema = z.discriminatedUnion('kind', [
  z.object({
    format: z.literal(DEFINITION_FORMAT),
    kind: z.literal('role'),
    approvedAt: z.string().optional(),
    definition: RoleDefinitionSchema,
  }),
  z.object({
    format: z.literal(DEFINITION_FORMAT),
    kind: z.literal('workflow'),
    approvedAt: z.string().optional(),
    definition: WorkflowDefinitionSchema,
  }),
]);
export type DefinitionFile = z.infer<typeof DefinitionFileSchema>;

/** `organization/<roles|workflows>/<key>/v<N>.yaml` inside the owner's vault. */
export function definitionVaultPath(kind: DefinitionKind, key: string, version: number): string {
  return `organization/${kind}s/${key}/v${version}.yaml`;
}

/** Deterministic YAML for one definition version (the same input always yields the same text). */
export function renderDefinitionFile(
  input:
    | { kind: 'role'; definition: RoleDefinition; approvedAt?: Date | string }
    | { kind: 'workflow'; definition: WorkflowDefinition; approvedAt?: Date | string },
): string {
  const approvedAt =
    input.approvedAt === undefined
      ? undefined
      : typeof input.approvedAt === 'string'
        ? input.approvedAt
        : input.approvedAt.toISOString();
  const doc = {
    format: DEFINITION_FORMAT,
    kind: input.kind,
    ...(approvedAt ? { approvedAt } : {}),
    definition: input.definition,
  };
  const parsed = DefinitionFileSchema.parse(doc);
  return `# Guildwise HQ definition. Provider neutral; edit it through the Organization page, not by hand.\n${stringify(parsed, { lineWidth: 0 })}`;
}

export function parseDefinitionFile(text: string): DefinitionFile {
  return DefinitionFileSchema.parse(parse(text));
}
