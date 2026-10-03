import type { AgentDto, RoleCatalogueEntrySchema } from '@aom/shared';
import { useState } from 'react';
import type { z } from 'zod';
import { usePatchAgent } from '../../api/queries/hr.ts';
import { Button, Dialog, ErrorBox, Select, TextInput } from '../ui.tsx';

type Role = z.infer<typeof RoleCatalogueEntrySchema>;

/** Change model and effort of an agent (`PATCH /api/agents/:id` -> `AgentChanged`). */
export function ChangeModelDialog({ agent, onClose }: { agent: AgentDto | null; onClose: () => void }) {
  const patch = usePatchAgent();
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<string | null>(null);
  return (
    <Dialog
      open={!!agent}
      onOpenChange={(o) => !o && onClose()}
      title={`Change model of ${agent?.name ?? ''}`}
      description="Applies from its next shift. The agent keeps its name, role and history."
    >
      {agent && (
        <form
          aria-label="Change model"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const next = model.trim() || agent.model;
            const eff = effort ?? agent.effort ?? '';
            patch.mutate(
              { id: agent.id, changes: { model: next, ...(eff ? { effort: eff } : {}) } },
              { onSuccess: onClose },
            );
          }}
        >
          <TextInput
            label="Model"
            placeholder={agent.model}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <Select
            label="Effort"
            value={effort ?? agent.effort ?? ''}
            onChange={(e) => setEffort(e.target.value)}
          >
            <option value="">Default</option>
            {['low', 'medium', 'high'].map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
          <ErrorBox error={patch.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={patch.isPending}>
              Change model
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Change the role (and seniority) of an agent; the server pins the new role's current version. */
export function ChangeRoleDialog({
  agent,
  roles,
  onClose,
}: {
  agent: AgentDto | null;
  roles: Role[];
  onClose: () => void;
}) {
  const patch = usePatchAgent();
  const [roleKey, setRoleKey] = useState('');
  const [seniority, setSeniority] = useState('');
  const hireable = roles.filter((r) => r.definition.key !== 'devops');
  const key = roleKey || agent?.roleKey || '';
  const role = hireable.find((r) => r.definition.key === key)?.definition;
  const sen =
    seniority && role?.seniorityLevels.includes(seniority as 'junior') ? seniority : (agent?.seniority ?? '');
  const effSen = role?.seniorityLevels.includes(sen as 'junior') ? sen : (role?.seniorityLevels[0] ?? sen);
  return (
    <Dialog
      open={!!agent}
      onOpenChange={(o) => !o && onClose()}
      title={`Change role of ${agent?.name ?? ''}`}
      description="Its name and track record stay; it claims cards of the new role from its next shift."
    >
      {agent && (
        <form
          aria-label="Change role"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            patch.mutate(
              {
                id: agent.id,
                changes: {
                  ...(key !== agent.roleKey ? { roleKey: key } : {}),
                  ...(effSen !== agent.seniority ? { seniority: effSen as 'junior' | 'senior' } : {}),
                },
              },
              { onSuccess: onClose },
            );
          }}
        >
          <Select label="Role" value={key} onChange={(e) => setRoleKey(e.target.value)}>
            {hireable.map((r) => (
              <option key={r.definition.key} value={r.definition.key}>
                {r.definition.name}
              </option>
            ))}
          </Select>
          <Select label="Seniority" value={effSen} onChange={(e) => setSeniority(e.target.value)}>
            {(role?.seniorityLevels ?? []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <ErrorBox error={patch.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={patch.isPending}>
              Change role
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
