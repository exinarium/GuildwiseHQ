import type { SetupStateDto } from '@aom/shared';
import { Link } from 'react-router';
import { useCanManageOrg } from '../../lib/orgRole.ts';
import { FollowupDefaultsPanel } from '../PhasesPanel.tsx';
import { allEnvironments, displayLabel, roleOf, rulesOf } from './model.ts';
import { Section } from './Section.tsx';

/** Rules: what must be true before a release, in sentences (journey I), and what a new phase does when it is finished. */
export function RulesSection({ projectId, s }: { projectId: string; s: SetupStateDto }) {
  const canManage = useCanManageOrg();
  const envs = allEnvironments(s).map((e) => e.env);
  const labelOf = (name: string) => {
    const e = envs.find((x) => x.name === name);
    return e ? displayLabel(e, roleOf(e)).toLowerCase() : name;
  };
  const withRules = envs
    .map((e) => ({ e, rules: rulesOf(e, labelOf) }))
    .filter((x) => x.rules.length > 0 && roleOf(x.e) !== 'test');
  return (
    <Section
      id="rules"
      title="Rules"
      sub="What must be true before a release."
      collapsible
      actions={
        canManage && (
          <Link
            to="/releases?tab=rules"
            className="inline-flex min-h-9 items-center text-sm font-medium text-brand hover:underline"
            data-testid="rules-edit"
          >
            Edit rules
          </Link>
        )
      }
    >
      {withRules.length === 0 ? (
        <p className="text-sm text-muted" data-testid="rules-empty">
          No extra rules yet. A live site is released by you, after you approve it.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="rules-list">
          {withRules.map(({ e, rules }) => (
            <li key={e.name} className="text-sm text-fg">
              <strong>{displayLabel(e, roleOf(e))}:</strong> {rules.join('. ')}.
            </li>
          ))}
        </ul>
      )}
      <FollowupDefaultsPanel projectId={projectId} />
    </Section>
  );
}
