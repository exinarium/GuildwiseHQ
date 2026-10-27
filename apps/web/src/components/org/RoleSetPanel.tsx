import { useState } from 'react';
import { Link } from 'react-router';
import { useRoleSet, useSetRoleSet } from '../../api/queries/org.ts';
import { Badge, Button, ErrorBox, Panel, Select } from '../ui.tsx';

const LABEL: Record<string, string> = { guildwise: 'Guildwise (stock roles)', bmad: 'BMAD Method' };

/**
 * "Role set" on Roles & workflows (docs/bmad-roles.md): which roles the organization runs. Choosing BMAD puts the set's
 * versions of the roles on the desk for approval; choosing Guildwise moves every agent back to the built-in versions.
 */
export function RoleSetPanel({ canEdit, projectId }: { canEdit: boolean; projectId?: string | undefined }) {
  const status = useRoleSet(projectId);
  const set = useSetRoleSet();
  const [choice, setChoice] = useState<'guildwise' | 'bmad' | ''>('');
  const current = status.data?.roleSet ?? 'guildwise';
  const pending = status.data?.pendingDeskItemId;
  const picked = choice || (current as 'guildwise' | 'bmad');
  if (!status.data) return null;
  return (
    <Panel data-testid="role-set">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-fg">Role set</h2>
        <Badge tone={current === 'bmad' ? 'violet' : 'blue'}>{LABEL[current] ?? current}</Badge>
        {status.data.pack && <span className="font-mono text-xs text-subtle">pack {status.data.pack}</span>}
      </div>
      <p className="mt-1 text-sm text-muted">
        BMAD gives the built-in roles the personas, working method and skills of the BMAD Method (an imported
        pack). Their instructions, core rules, permissions and stages stay the same. It also adds a UX
        designer role.
      </p>
      {pending && (
        <p className="mt-2 text-sm" data-testid="role-set-pending">
          <Badge tone="amber">Waiting for approval</Badge>{' '}
          <Link to="/desk" className="text-brand-text underline">
            Approve the role set on the desk
          </Link>
        </p>
      )}
      {canEdit && !pending && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Select
            label="Run the roles of"
            value={picked}
            onChange={(e) => setChoice(e.target.value as 'guildwise' | 'bmad')}
          >
            <option value="guildwise">{LABEL.guildwise}</option>
            <option value="bmad">{LABEL.bmad}</option>
          </Select>
          <Button
            variant="primary"
            disabled={picked === current || set.isPending}
            onClick={() =>
              set.mutate({ projectId, body: { roleSet: picked } }, { onSuccess: () => setChoice('') })
            }
          >
            {picked === 'guildwise' && current !== 'guildwise' ? 'Switch back' : 'Switch'}
          </Button>
        </div>
      )}
      <ErrorBox error={set.error} />
    </Panel>
  );
}
