import { type ComponentRule, ComponentRulesSchema } from '@aom/shared';
import { one, type Queryable } from '../db/sql.ts';

/** The component rules of a repository, as stored (an unreadable value counts as none). The one place this card reads them. */
export async function loadComponentRules(db: Queryable, repoId: string): Promise<ComponentRule[]> {
  const r = await one(db, 'SELECT component_rules FROM project_repos WHERE id=$1', [repoId]);
  return ComponentRulesSchema.catch([]).parse(r?.component_rules ?? []);
}
