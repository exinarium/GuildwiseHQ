import { useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { useBulkMoveTargets } from '../../api/queries/agent-move.ts';
import { useRetirePreview, useRetireWorkstation } from '../../api/queries/workstations.ts';
import { Button, Dialog, ErrorBox, Select, useToast } from '../ui.tsx';

export interface RetireTarget {
  id: string;
  name: string;
}

type Failed = { id: string; name: string; code: string; message: string };
type Working = { id: string; name: string; cardRef?: string | null };

const detailsOf = <T,>(e: unknown, key: string): T[] => {
  const d = e instanceof ApiError ? (e.details as Record<string, unknown> | undefined) : undefined;
  const v = d?.[key];
  return Array.isArray(v) ? (v as T[]) : [];
};

/**
 * Retire a workstation: its agents are moved to another workstation or marked as needing a new home. The choice is a
 * radio and a native select, so no soft keyboard opens; a refusal is listed inside the dialog.
 */
export function RetireWorkstationDialog({
  workstation,
  onClose,
}: {
  workstation: RetireTarget | null;
  onClose: () => void;
}) {
  const id = workstation?.id;
  const preview = useRetirePreview(id);
  const targets = useBulkMoveTargets(id);
  const retire = useRetireWorkstation(id ?? '');
  const toast = useToast();
  const [mode, setMode] = useState<'move' | 'needs_rehome'>('move');
  const [pick, setPick] = useState('');
  const [ack, setAck] = useState(false);
  const p = preview.data;
  const list = targets.data?.workstations ?? [];
  const eff = pick || list[0]?.id || '';
  const target = list.find((w) => w.id === eff);
  const noTargets = !!targets.data && list.length === 0;
  const hasAgents = (p?.agents.length ?? 0) > 0;
  const working = p?.working ?? [];
  const blocked = working.length > 0;
  const effMode = noTargets ? 'needs_rehome' : mode;
  const failed = detailsOf<Failed>(retire.error, 'failed');
  const refused = detailsOf<Working>(retire.error, 'agents');
  const needAck = failed.some((f) => f.code === 'unsandboxed_ack_required') && !ack;
  const close = () => {
    retire.reset();
    setAck(false);
    onClose();
  };
  const submit = () => {
    if (!workstation || !p) return;
    retire.mutate(
      hasAgents
        ? effMode === 'move'
          ? {
              handover: 'move',
              targetWorkstationId: eff,
              ...(ack ? { acknowledgeUnsandboxed: true } : {}),
            }
          : { handover: 'needs_rehome' }
        : {},
      {
        onSuccess: (r) => {
          const n = r.moved.length + r.needsRehome.length;
          toast.success(
            r.handover === 'move'
              ? `${workstation.name} retired: ${n} ${n === 1 ? 'agent' : 'agents'} moved to ${target?.name ?? 'the new workstation'}`
              : r.handover === 'needs_rehome'
                ? `${workstation.name} retired: ${n} ${n === 1 ? 'agent needs' : 'agents need'} a new home`
                : `${workstation.name} retired`,
          );
          close();
        },
      },
    );
  };
  const row = 'flex min-h-11 items-start gap-2 rounded-md border border-border p-2 text-sm';
  return (
    <Dialog
      open={!!workstation}
      onOpenChange={(o) => !o && close()}
      title={`Retire ${workstation?.name ?? ''}?`}
      description="Its agents, their history and their project assignments are kept; nothing is deleted."
    >
      {workstation && (
        <form
          aria-label="Retire workstation"
          className="flex max-h-[80vh] flex-col gap-3 overflow-auto"
          onSubmit={(e) => {
            e.preventDefault();
            if (!blocked && !needAck && (!hasAgents || effMode !== 'move' || eff)) submit();
          }}
        >
          {preview.isPending && <p className="text-sm">Checking the workstation…</p>}
          {p && (
            <div className="flex flex-col gap-3">
              {p.workstation.status === 'active' && (
                <p className="text-sm" data-testid="retire-unpair-note">
                  This also unpairs the computer: its token is revoked and the runner stops.
                </p>
              )}
              {hasAgents ? (
                <div data-testid="retire-agents">
                  <p className="text-sm font-medium">
                    {p.agents.length} {p.agents.length === 1 ? 'agent' : 'agents'} to hand over
                  </p>
                  <ul className="mt-1 max-h-[30vh] list-disc overflow-auto pl-5 text-sm">
                    {p.agents.map((a) => (
                      <li key={a.id}>
                        {a.name} ({a.roleKey}){a.otherOrg ? ' — another organization: needs a new home' : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm" data-testid="retire-no-agents">
                  This workstation has no agents. It is retired directly.
                </p>
              )}
              {p.devops.length > 0 && (
                <p className="text-sm" data-testid="retire-devops">
                  The DevOps {p.devops.length === 1 ? 'engineer' : 'engineers'} (
                  {p.devops.map((d) => d.name).join(', ')}){p.devops.length === 1 ? ' is' : ' are'} retired
                  with the workstation.
                </p>
              )}
              {p.homedCards.length > 0 && (
                <p className="text-sm" data-testid="retire-cards">
                  These cards restart from the base branch: {p.homedCards.map((c) => c.ref).join(', ')}.
                </p>
              )}
            </div>
          )}
          {p && hasAgents && (
            <fieldset className="flex flex-col gap-2" disabled={retire.isPending}>
              <legend className="sr-only">What happens to its agents</legend>
              <label className={row}>
                <input
                  type="radio"
                  name="retire-handover"
                  className="mt-1 size-5"
                  checked={effMode === 'move'}
                  disabled={noTargets}
                  onChange={() => setMode('move')}
                />
                <span className="flex flex-1 flex-col gap-2">
                  <span>Move its agents to another workstation</span>
                  {noTargets && <span data-testid="retire-no-targets">Pair another workstation first.</span>}
                  {effMode === 'move' && list.length > 0 && (
                    <Select label="Move to" value={eff} onChange={(e) => setPick(e.target.value)}>
                      {list.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name} · {w.mine ? 'you' : w.ownerName} ({w.connected ? 'online' : 'offline'})
                        </option>
                      ))}
                    </Select>
                  )}
                </span>
              </label>
              <label className={row}>
                <input
                  type="radio"
                  name="retire-handover"
                  className="mt-1 size-5"
                  checked={effMode === 'needs_rehome'}
                  onChange={() => setMode('needs_rehome')}
                />
                <span>Mark its agents as needing a new home (re-home them one by one later)</span>
              </label>
            </fieldset>
          )}
          {blocked && (
            <div role="alert" data-testid="retire-working" className="text-sm">
              <p className="font-medium">Retiring is not possible while these agents are working:</p>
              <ul className="mt-1 list-disc pl-5">
                {working.map((a) => (
                  <li key={a.id}>
                    {a.name}
                    {a.cardRef ? ` (${a.cardRef})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!blocked && refused.length > 0 && (
            <div role="alert" data-testid="retire-refused" className="text-sm">
              <p className="font-medium">Retiring is not possible while these agents are working:</p>
              <ul className="mt-1 list-disc pl-5">
                {refused.map((a) => (
                  <li key={a.id}>
                    {a.name}
                    {a.cardRef ? ` (${a.cardRef})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {failed.length > 0 && (
            <div role="alert" data-testid="retire-failed" className="text-sm">
              <p className="font-medium">These agents cannot move to {target?.name ?? 'that workstation'}:</p>
              <ul className="mt-1 list-disc pl-5">
                {failed.map((f) => (
                  <li key={f.id}>
                    {f.name}: {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {failed.some((f) => f.code === 'unsandboxed_ack_required') && (
            <label className="flex min-h-11 items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                className="mt-1 size-5"
              />
              <span>I understand these agents run without an OS sandbox on {target?.name}</span>
            </label>
          )}
          {failed.length === 0 && refused.length === 0 && <ErrorBox error={retire.error} />}
          <ErrorBox error={preview.error ?? targets.error} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button className="min-h-11" onClick={close}>
              Cancel
            </Button>
            {(blocked || refused.length > 0) && (
              <Button className="min-h-11" onClick={() => preview.refetch()}>
                Check again
              </Button>
            )}
            <Button
              type="submit"
              variant="danger"
              className="min-h-11"
              disabled={
                !p || blocked || retire.isPending || needAck || (hasAgents && effMode === 'move' && !eff)
              }
            >
              Retire
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
