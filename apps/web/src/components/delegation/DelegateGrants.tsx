import {
  DELEGATE_GRANT_LIMITS,
  type DelegateGrantDto,
  type DelegateOwnerKind,
  type DelegateProfile,
} from '@aom/shared';
import { useState } from 'react';
import { useMe } from '../../api/queries/auth.ts';
import { useDelegateGrants, useDelegateTargets, useSetDelegateGrant } from '../../api/queries/delegation.ts';
import { useWorkstations } from '../../api/queries/workstations.ts';
import { ModelSelect, unionExtras, unionProviders } from '../ModelSelect.tsx';
import { Badge, Callout, ErrorBox } from '../ui.tsx';

export const profileText = (p: DelegateProfile | null): string =>
  p === 'shell'
    ? 'can edit files and run commands'
    : p === 'edit'
      ? 'can edit files'
      : p === 'read_only'
        ? 'reads only'
        : 'its own tools, at most the caller’s';

function Row({
  g,
  canManage,
  onRemove,
  busy,
}: {
  g: DelegateGrantDto;
  canManage: boolean;
  onRemove: () => void;
  busy: boolean;
}) {
  return (
    <li
      data-testid={`delegate-grant-${g.targetKey}`}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border border-line bg-surface px-3 py-2 text-sm"
    >
      <span className="font-medium text-fg">{g.targetName}</span>
      <Badge tone={g.targetKind === 'agent' ? 'violet' : 'neutral'}>
        {g.targetKind === 'agent' ? 'Agent' : 'Persona'}
      </Badge>
      <span className="text-muted" data-testid="delegate-grant-model">
        {g.modelOverride
          ? `runs on ${g.modelOverride} for this caller`
          : g.model
            ? `runs on ${g.model}`
            : 'runs on its own model'}
      </span>
      {g.inherited && (
        <Badge tone="violet" data-testid="delegate-grant-inherited">
          from the role
        </Badge>
      )}
      <span className="text-muted">{profileText(g.maxProfile ?? g.profile)}</span>
      <span className="text-subtle">
        up to {g.maxCalls} call{g.maxCalls === 1 ? '' : 's'} a turn, {g.timeoutSec} s each
      </span>
      {g.problem && (
        <span className="text-xs text-warning-text" role="status">
          {g.problem}
        </span>
      )}
      {canManage && !g.inherited && (
        <button
          type="button"
          aria-label={`Remove ${g.targetName}`}
          className="ml-auto text-subtle hover:text-fg [@media(pointer:coarse)]:min-h-11"
          disabled={busy}
          onClick={onRemove}
        >
          Remove
        </button>
      )}
    </li>
  );
}

/**
 * What an agent, or the facilitator and Chair of one session, may hand sub-tasks to. Off by default: nothing is listed until an
 * Owner, an Admin or the agent's manager (for a session, its creator) allows a target. Each target runs on the model configured
 * for it; the caller cannot choose one, and the tools of a child are never wider than the caller's.
 */
function Body({ kind, id }: { kind: DelegateOwnerKind; id: string }) {
  const grants = useDelegateGrants(kind, id);
  const canManage = grants.data?.canManage ?? false;
  const targets = useDelegateTargets(kind, id, canManage);
  const set = useSetDelegateGrant(kind, id);
  const [pick, setPick] = useState('');
  const [maxCalls, setMaxCalls] = useState<number>(DELEGATE_GRANT_LIMITS.defaultMaxCalls);
  const [timeoutSec, setTimeoutSec] = useState<number>(DELEGATE_GRANT_LIMITS.defaultTimeoutSec);
  const [ceiling, setCeiling] = useState<'' | DelegateProfile>('');
  // R3c (Q62): the model the target runs on for this caller; empty: the target's own
  const [model, setModel] = useState('');
  const me = useMe();
  const stations = useWorkstations({ enabled: canManage });
  const mine = (stations.data ?? []).filter((w) => w.userId === me.data?.user?.id && w.status === 'active');
  if (grants.isPending) return null;
  const list = grants.data?.grants ?? [];
  const options = (targets.data ?? []).filter((t) => !t.granted);
  const chosen = options.find((o) => `${o.targetKind}:${o.targetKey}` === pick);
  const who =
    kind === 'agent'
      ? 'this agent'
      : kind === 'role'
        ? 'every agent of this role'
        : 'the facilitator and the Chair of this session';
  return (
    <section
      aria-labelledby={`delegation-h-${id}`}
      data-testid="delegate-grants"
      className="flex flex-col gap-2"
    >
      <h3 id={`delegation-h-${id}`} className="text-base font-semibold text-fg">
        Delegation
      </h3>
      <p className="text-sm text-muted">
        Off by default.{' '}
        {kind === 'role'
          ? 'Every agent of this role, the ones hired later too'
          : kind === 'agent'
            ? 'This agent'
            : 'The facilitator and the Chair'}{' '}
        may hand a self-contained sub-task to the targets listed here, and to no one else. Each target runs on
        the model configured for it (or the one a grant sets), with tools never wider than{' '}
        {kind === 'session' ? 'a conversation’s (reading)' : 'the caller’s'}; what it costs is booked here and
        shows as a sub-step.
        {kind === 'agent' && grants.data?.roleKey
          ? ` Targets marked "from the role" come from the role ${grants.data.roleKey} and are changed there; here you can add more.`
          : ''}
      </p>
      {list.length === 0 ? (
        <p className="text-sm text-subtle" data-testid="delegate-grants-none">
          None. {kind === 'role' ? 'Agents of this role' : kind === 'agent' ? 'This agent' : 'This session'}{' '}
          cannot delegate.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((g) => (
            <Row
              key={`${g.targetKind}:${g.targetKey}`}
              g={g}
              canManage={canManage}
              busy={set.isPending}
              onRemove={() => set.mutate({ targetKind: g.targetKind, targetKey: g.targetKey, grant: null })}
            />
          ))}
        </ul>
      )}
      {canManage ? (
        <div className="flex flex-wrap items-end gap-2" data-testid="delegate-grant-form">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Target
            <select
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              aria-label="Delegation target"
              className="h-9 rounded-control border border-control bg-surface px-2 text-sm text-fg"
            >
              <option value="">Choose a persona or an agent</option>
              <optgroup label="Personas">
                {options
                  .filter((o) => o.targetKind === 'persona')
                  .map((o) => (
                    <option key={o.targetKey} value={`persona:${o.targetKey}`}>
                      {o.name} ({o.targetKey})
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Agents">
                {options
                  .filter((o) => o.targetKind === 'agent')
                  .map((o) => (
                    <option key={o.targetKey} value={`agent:${o.targetKey}`}>
                      {o.name} ({o.model})
                    </option>
                  ))}
              </optgroup>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Calls a turn
            <input
              type="number"
              min={1}
              max={DELEGATE_GRANT_LIMITS.maxCallsCap}
              value={maxCalls}
              onChange={(e) => setMaxCalls(Number(e.target.value))}
              aria-label="Calls per turn"
              className="h-9 w-20 rounded-control border border-control bg-surface px-2 text-sm text-fg"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Seconds each
            <input
              type="number"
              min={DELEGATE_GRANT_LIMITS.minTimeoutSec}
              max={DELEGATE_GRANT_LIMITS.maxTimeoutSec}
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(Number(e.target.value))}
              aria-label="Seconds per call"
              className="h-9 w-24 rounded-control border border-control bg-surface px-2 text-sm text-fg"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Tools at most
            <select
              value={ceiling}
              onChange={(e) => setCeiling(e.target.value as '' | DelegateProfile)}
              aria-label="Tool ceiling"
              className="h-9 rounded-control border border-control bg-surface px-2 text-sm text-fg"
            >
              <option value="">The target’s own</option>
              <option value="read_only">Read only</option>
              <option value="edit">Edit files</option>
              <option value="shell">Edit and run commands</option>
            </select>
          </label>
          <div className="min-w-48">
            <ModelSelect
              label="Model for this caller"
              value={model}
              onChange={setModel}
              runtimes={mine.flatMap((w) => w.runtimes.filter((r) => r.available).map((r) => r.id))}
              providers={unionProviders(mine)}
              extras={unionExtras(mine)}
              defaultLabel="The target’s own"
              ariaLabel="Model for this caller"
            />
          </div>
          <button
            type="button"
            disabled={!chosen || set.isPending}
            onClick={() => {
              if (!chosen) return;
              const [runtime, ...rest] = model.split('/');
              set.mutate(
                {
                  targetKind: chosen.targetKind,
                  targetKey: chosen.targetKey,
                  grant: {
                    maxCalls,
                    timeoutSec,
                    maxProfile: ceiling === '' ? null : ceiling,
                    model: model && runtime && rest.length ? { runtime, model: rest.join('/') } : null,
                  },
                },
                { onSuccess: () => setPick('') },
              );
            }}
            className="h-9 rounded-control bg-brand px-3 text-sm text-brand-fg disabled:bg-sunken disabled:text-disabled-fg"
          >
            Allow
          </button>
        </div>
      ) : (
        <Callout tone="info">
          {kind === 'agent'
            ? 'Only an Owner, an Admin or the agent’s manager changes this list.'
            : kind === 'role'
              ? 'Only an Owner or an Admin changes a role’s list.'
              : 'Only the creator of the session, an Owner or an Admin changes this list.'}
        </Callout>
      )}
      <ErrorBox error={set.error} />
    </section>
  );
}

/** A disclosure: nothing is fetched until it is opened (an agents list has many cards). */
export function DelegateGrants({ ownerKind, ownerId }: { ownerKind: DelegateOwnerKind; ownerId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        data-testid="delegate-grants-toggle"
        onClick={() => setOpen((o) => !o)}
        className="text-sm font-medium text-brand-text hover:underline [@media(pointer:coarse)]:min-h-11"
      >
        {open
          ? 'Hide delegation'
          : ownerKind === 'agent'
            ? 'Who it may delegate to'
            : ownerKind === 'role'
              ? 'Who agents of this role may delegate to'
              : 'Delegation'}
      </button>
      {open && (
        <div className="mt-2">
          <Body kind={ownerKind} id={ownerId} />
        </div>
      )}
    </div>
  );
}
