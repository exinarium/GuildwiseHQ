import { useState } from 'react';
import { useMentionPolicy, useSetMentionPolicy } from '../../api/queries/agent-ux.ts';
import { Callout, ErrorBox } from '../ui.tsx';

function Body({ agentId, canManage }: { agentId: string; canManage: boolean }) {
  const q = useMentionPolicy(agentId);
  const set = useSetMentionPolicy(agentId);
  const allow = q.data?.allowMembers === true;
  return (
    <section className="flex flex-col gap-2 text-sm" aria-label="Mentions in card comments">
      <p className="text-subtle">
        Anyone in a card thread can type @ and the agent&apos;s name to ask it a small question about the
        card. The agent only reads and answers; the cost is booked to the card. Owners and Admins can always
        do it.
      </p>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1"
          data-testid="mention-policy-members"
          checked={allow}
          disabled={!canManage || q.isPending || set.isPending}
          onChange={(e) => set.mutate({ allowMembers: e.target.checked })}
        />
        <span>Project members may mention this agent</span>
      </label>
      {!canManage && (
        <Callout tone="info">Only an Owner, an Admin or the agent&apos;s manager changes this.</Callout>
      )}
      <ErrorBox error={set.error} />
    </section>
  );
}

/** A disclosure on the agent's card: nothing is fetched until it is opened. */
export function MentionPolicy({ agentId, canManage }: { agentId: string; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        data-testid="mention-policy-toggle"
        onClick={() => setOpen((o) => !o)}
        className="text-sm font-medium text-brand-text hover:underline [@media(pointer:coarse)]:min-h-11"
      >
        {open ? 'Hide who may mention it' : 'Who may mention it'}
      </button>
      {open && (
        <div className="mt-2">
          <Body agentId={agentId} canManage={canManage} />
        </div>
      )}
    </div>
  );
}
