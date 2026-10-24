import { useMemo, useState } from 'react';
import { usePlaybookGrants, useSetPlaybookGrant, useSlashCommands } from '../../api/queries/playbooks.ts';
import { Callout, ErrorBox } from '../ui.tsx';

/**
 * The playbooks an agent may start by itself (`aom playbook run`). Off by default: an empty list means the agent cannot start any.
 * A guided session it starts belongs to the agent's manager, who is asked for the answers. Only an Owner, an Admin or the
 * agent's manager changes the list.
 */
function PlaybookGrantsBody({ agentId }: { agentId: string }) {
  const grants = usePlaybookGrants(agentId);
  const set = useSetPlaybookGrant(agentId);
  const menu = useSlashCommands('session');
  const [pick, setPick] = useState('');
  const granted = grants.data?.keys ?? [];
  const canManage = grants.data?.canManage ?? false;
  const nameOf = useMemo(() => new Map((menu.data?.items ?? []).map((i) => [i.key, i.name])), [menu.data]);
  const options = (menu.data?.items ?? []).filter((i) => i.kind === 'playbook' && !granted.includes(i.key));
  if (grants.isPending) return null;
  return (
    <section
      aria-labelledby="playbook-grants-h"
      data-testid="playbook-grants"
      className="flex flex-col gap-2"
    >
      <h3 id="playbook-grants-h" className="text-base font-semibold text-fg">
        Playbooks it may start
      </h3>
      <p className="text-sm text-muted">
        Off by default. A playbook listed here can be started by this agent with <code>aom playbook run</code>
        : it opens a guided session for the agent&apos;s manager, who answers the questions. At most three a
        day.
      </p>
      {granted.length === 0 ? (
        <p className="text-sm text-subtle" data-testid="playbook-grants-none">
          None. This agent cannot start a playbook.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {granted.map((k) => (
            <li
              key={k}
              data-testid={`playbook-grant-${k}`}
              className="inline-flex items-center gap-2 rounded-full border border-line bg-sunken px-3 py-1 text-sm"
            >
              {nameOf.get(k) ?? k}
              {canManage && (
                <button
                  type="button"
                  aria-label={`Remove ${nameOf.get(k) ?? k}`}
                  className="text-subtle hover:text-fg"
                  disabled={set.isPending}
                  onClick={() => set.mutate({ key: k, granted: false })}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`pb-pick-${agentId}`}>
            Playbook to allow
          </label>
          <select
            id={`pb-pick-${agentId}`}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="h-9 rounded-control border border-control bg-surface px-2 text-sm"
          >
            <option value="">Choose a playbook</option>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.name} ({o.key})
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!pick || set.isPending}
            onClick={() => set.mutate({ key: pick, granted: true }, { onSuccess: () => setPick('') })}
            className="h-9 rounded-control bg-brand px-3 text-sm text-brand-fg disabled:bg-sunken disabled:text-disabled-fg"
          >
            Allow
          </button>
        </div>
      ) : (
        <Callout tone="info">Only an Owner, an Admin or the agent&apos;s manager changes this list.</Callout>
      )}
      <ErrorBox error={set.error} />
    </section>
  );
}

/** A disclosure on the agent's card: nothing is fetched until it is opened (an agents list has many cards). */
export function PlaybookGrants({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        data-testid="playbook-grants-toggle"
        onClick={() => setOpen((o) => !o)}
        className="text-sm font-medium text-brand-text hover:underline [@media(pointer:coarse)]:min-h-11"
      >
        {open ? 'Hide playbooks it may start' : 'Playbooks it may start'}
      </button>
      {open && (
        <div className="mt-2">
          <PlaybookGrantsBody agentId={agentId} />
        </div>
      )}
    </div>
  );
}
