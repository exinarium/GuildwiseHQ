import type { InterestDto } from '@aom/shared';
import { useState } from 'react';
import { useEligibleAgents, usePatchInterest } from '../../api/queries/interests.ts';
import {
  type InterestFormValues,
  toPatchRequest,
  validateInterest,
  valuesFromInterest,
} from '../../lib/interests.ts';
import { BudgetPanel } from '../BudgetPanel.tsx';
import { Button, Callout, ErrorBox, Select, useToast } from '../ui.tsx';
import { InterestForm } from './InterestForm.tsx';

const ROLES = [
  { key: 'scout', label: 'Scout' },
  { key: 'curator', label: 'Curator' },
  { key: 'researcher', label: 'Researcher' },
  { key: 'checker', label: 'Fact checker' },
] as const;

type AgentKey = (typeof ROLES)[number]['key'];

/** Settings: the interest's statement, its run and delivery schedules, its limits and the agents it prefers. */
export function SettingsTab({ interest }: { interest: InterestDto }) {
  const patch = usePatchInterest();
  const eligible = useEligibleAgents(interest.id);
  const toast = useToast();
  const [v, setV] = useState<InterestFormValues>(() => valuesFromInterest(interest));
  const [agents, setAgents] = useState<Record<AgentKey, string>>(() => ({
    scout: interest.agents.scout?.id ?? '',
    curator: interest.agents.curator?.id ?? '',
    researcher: interest.agents.researcher?.id ?? '',
    checker: interest.agents.checker?.id ?? '',
  }));
  const [errors, setErrors] = useState<ReturnType<typeof validateInterest>>({});
  const readOnly = !interest.canManage || interest.archived;
  const set = <K extends keyof InterestFormValues>(k: K, val: InterestFormValues[K]) =>
    setV((cur) => ({ ...cur, [k]: val }));
  const submit = () => {
    const found = validateInterest(v);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    patch.mutate(
      {
        id: interest.id,
        body: {
          ...toPatchRequest(v, interest.stats.lastRunAt !== null),
          agents: Object.fromEntries(ROLES.map((r) => [r.key, agents[r.key] || null])),
        },
      },
      { onSuccess: () => toast.success('Settings saved') },
    );
  };
  return (
    <div className="flex flex-col gap-4" data-testid="settings-tab">
      {readOnly && (
        <Callout tone="info" data-testid="interest-readonly">
          {interest.archived
            ? 'This interest is archived: restore it to change it.'
            : 'You can see this interest but not change it: only its creator, or someone of the same or a higher role, can.'}
        </Callout>
      )}
      <InterestForm
        v={v}
        set={set}
        errors={errors}
        disabled={readOnly}
        domainLocked={interest.stats.lastRunAt !== null}
      />
      <fieldset className="flex flex-col gap-2 rounded-card border border-line p-3">
        <legend className="px-1 text-sm font-medium text-fg">Preferred agents</legend>
        <p className="text-xs text-subtle">
          A soft preference: an assigned agent is offered the run first, but any qualified agent that is
          allowed to work takes it at once. Nobody waits for the preferred agent.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {ROLES.map((r) => (
            <Select
              key={r.key}
              label={r.label}
              value={agents[r.key]}
              disabled={readOnly}
              data-testid={`interest-agent-${r.key}`}
              onChange={(e) => setAgents((cur) => ({ ...cur, [r.key]: e.target.value }))}
            >
              <option value="">Any qualified agent</option>
              {(eligible.data?.[r.key] ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.online ? '' : ' (offline)'}
                </option>
              ))}
            </Select>
          ))}
        </div>
      </fieldset>
      <fieldset className="flex items-center gap-4 text-sm">
        <legend className="mb-1 text-sm font-medium text-fg">Status</legend>
        {(['active', 'paused'] as const).map((s) => (
          <label key={s} className="flex min-h-9 items-center gap-1.5 [@media(pointer:coarse)]:min-h-11">
            <input
              type="radio"
              name="interest-status"
              value={s}
              checked={v.status === s}
              disabled={readOnly}
              onChange={() => set('status', s)}
            />
            {s === 'active' ? 'Active' : 'Paused'}
          </label>
        ))}
      </fieldset>
      <ErrorBox error={patch.error} />
      <div id="budget" className="scroll-mt-20">
        <BudgetPanel kind="interests" id={interest.id} budget={interest.budget} what="interest" />
      </div>
      {!readOnly && (
        <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-line bg-surface px-4 py-3 sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0">
          <Button variant="primary" loading={patch.isPending} data-testid="interest-save" onClick={submit}>
            Save settings
          </Button>
        </div>
      )}
    </div>
  );
}
