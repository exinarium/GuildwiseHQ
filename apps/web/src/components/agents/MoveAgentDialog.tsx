import { useState } from 'react';
import { Link } from 'react-router';
import { useMoveTargets, useRehomeAgent } from '../../api/queries/members.ts';
import { agentWarning, isRuntimeUnsandboxed, sandboxReasonOf } from '../../lib/sandbox.ts';
import { SandboxWarning } from '../SandboxWarning.tsx';
import { Button, Dialog, ErrorBox, Select, TextInput } from '../ui.tsx';

/** What the move dialog needs to know about an agent (the Agents page and the org chart both map to it). */
export type MovableAgent = {
  id: string;
  name: string;
  status: string;
  runtime: string;
  model: string;
  isDevops: boolean;
};

/**
 * Moves an agent to another workstation of its organization: a `needs_rehome` agent gets a new home ("rehome"), any
 * other agent moves (for example off a workstation that is offline or was unpaired). Name and history carry over.
 * Runtime and model are kept unless the target lacks the runtime (said in the dialog) or the user picks others.
 */
export function MoveAgentDialog({ agent, onClose }: { agent: MovableAgent | null; onClose: () => void }) {
  const targets = useMoveTargets(agent?.id);
  const rehome = useRehomeAgent();
  const rehoming = agent?.status === 'needs_rehome';
  const list = targets.data?.workstations ?? [];
  const [stationId, setStationId] = useState('');
  const [runtime, setRuntime] = useState('');
  const [model, setModel] = useState('');
  const eff = stationId || list[0]?.id || '';
  const station = list.find((w) => w.id === eff);
  const runtimes = station?.runtimes.filter((r) => r.available).map((r) => r.id) ?? [];
  const effRuntime =
    runtime && runtimes.includes(runtime)
      ? runtime
      : agent && runtimes.includes(agent.runtime)
        ? agent.runtime
        : (runtimes[0] ?? agent?.runtime ?? '');
  const runtimeChanges = !!agent && !!station && !runtime && effRuntime !== agent.runtime;
  const rehomeUnsandboxed = !!station && isRuntimeUnsandboxed(station.runtimes, effRuntime);
  const [rehomeAck, setRehomeAck] = useState(false);
  const devopsThere = agent?.isDevops && station?.devops ? station.devops : null;
  const current = targets.data?.current;
  const close = () => {
    rehome.reset();
    onClose();
  };
  return (
    <Dialog
      open={!!agent}
      onOpenChange={(o) => !o && close()}
      title={rehoming ? `Re-home ${agent?.name ?? ''}` : `Move ${agent?.name ?? ''} to another workstation`}
      description="The name, history, projects and track record carry over; the old sandbox stays behind."
    >
      {agent && (
        <form
          aria-label={rehoming ? 'Re-home agent' : 'Move agent'}
          className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto"
          onSubmit={(e) => {
            e.preventDefault();
            if (!eff || devopsThere) return;
            rehome.mutate(
              {
                agentId: agent.id,
                workstationId: eff,
                runtime: effRuntime,
                model: model.trim() || agent.model,
                ...(rehomeUnsandboxed && rehomeAck ? { acknowledgeUnsandboxed: true } : {}),
              },
              { onSuccess: close },
            );
          }}
        >
          {targets.data && (
            <p className="text-sm text-subtle" data-testid="move-now-on">
              {current ? `Now on: ${current.name} (${current.state})` : 'Now on: no workstation'}
            </p>
          )}
          {targets.data && list.length === 0 ? (
            <p className="text-sm" data-testid="move-no-targets">
              No other workstation in this organization.{' '}
              <Link to="/workstations" className="text-brand-text hover:underline">
                Pair one on the Workstations page.
              </Link>
            </p>
          ) : (
            <Select label="Workstation" value={eff} onChange={(e) => setStationId(e.target.value)}>
              {list.length === 0 && <option value="">Loading workstations…</option>}
              {list.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} · {w.mine ? 'you' : w.ownerName} ({w.connected ? 'connected' : 'offline'})
                  {agent.isDevops && w.devops ? ' · has DevOps' : ''}
                </option>
              ))}
            </Select>
          )}
          {station && !station.mine && (
            <p className="text-xs text-subtle" data-testid="move-others-hint">
              {station.ownerName}'s workstation: the agent works only the projects {station.ownerName} is on,
              with the repositories cloned there.
            </p>
          )}
          {devopsThere && station && (
            <p
              role="alert"
              data-testid="move-devops-warning"
              className="rounded-control border border-line bg-sunken px-3 py-2 text-sm text-fg"
            >
              One DevOps engineer per workstation: {station.name} already has {devopsThere.name}, so this move
              will be refused.
            </p>
          )}
          <Select label="Runtime" value={effRuntime} onChange={(e) => setRuntime(e.target.value)}>
            {(runtimes.length ? runtimes : [agent.runtime]).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          {runtimeChanges && station && (
            <p className="text-xs text-subtle" data-testid="move-runtime-changes">
              {agent.runtime} is not available on {station.name}: the agent will use {effRuntime}.
            </p>
          )}
          <TextInput
            label="Model"
            placeholder={agent.model}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          {rehomeUnsandboxed && station && (
            <div className="flex flex-col gap-2">
              <SandboxWarning testId="rehome-sandbox-warning" role="alert" lead="Warning:">
                {agentWarning(station.name, sandboxReasonOf(station.runtimes, effRuntime))}
              </SandboxWarning>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={rehomeAck}
                  onChange={(e) => setRehomeAck(e.target.checked)}
                  className="mt-1"
                />
                <span>I understand this agent runs without an OS sandbox on {station.name}</span>
              </label>
            </div>
          )}
          <ErrorBox error={rehome.error ?? targets.error} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={rehome.isPending || !eff || !!devopsThere}>
              {rehoming ? 'Re-home' : 'Move'}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
