import type { AgentHome, MoveAllAgentsResponse, MoveSkipReason } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useBulkMoveTargets, useMoveAllAgents, useMoveAllPreview } from '../../api/queries/agent-move.ts';
import { Button, Dialog, ErrorBox, Select } from '../ui.tsx';

const SKIP_TEXT: Record<MoveSkipReason, string> = {
  running_shift: 'in a running shift: move it once the shift ends',
  workstation_devops: "the workstation's own DevOps engineer stays with it",
  ceo: 'the CEO moves on the CEO page',
};

const skipText = (s: MoveAllAgentsResponse['skipped'][number]) =>
  s.reason === 'running_shift' && s.message ? s.message : SKIP_TEXT[s.reason];

function Names({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <div data-testid={testId}>
      <p className="text-sm font-medium">{title}</p>
      <ul className="mt-1 max-h-[50vh] list-disc overflow-auto pl-5 text-sm">{children}</ul>
    </div>
  );
}

function Lists({ r }: { r: MoveAllAgentsResponse }) {
  const sameFailure = r.failed.length > 1 && r.failed.every((f) => f.code === r.failed[0]?.code);
  return (
    <div className="flex flex-col gap-3">
      {r.moved.length > 0 && (
        <Names title={`Moved (${r.moved.length})`} testId="move-all-moved">
          {r.moved.map((a) => (
            <li key={a.agentId}>{a.name}</li>
          ))}
        </Names>
      )}
      {r.skipped.length > 0 && (
        <Names title={`Skipped (${r.skipped.length})`} testId="move-all-skipped">
          {r.skipped.map((a) => (
            <li key={a.agentId}>
              {a.name}: {skipText(a)}
            </li>
          ))}
        </Names>
      )}
      {r.failed.length > 0 && (
        <div className="flex flex-col gap-1">
          {sameFailure && (
            <p className="text-sm" role="alert">
              {r.failed[0]?.error}
            </p>
          )}
          <Names title={`Could not move (${r.failed.length})`} testId="move-all-failed">
            {r.failed.map((a) => (
              <li key={a.agentId}>
                {a.name}
                {sameFailure ? '' : `: ${a.error}`}
              </li>
            ))}
          </Names>
        </div>
      )}
    </div>
  );
}

/** Moves every agent of one workstation to another: preview the count, confirm, then see who moved and who did not. */
export function MoveAllAgentsDialog({ source, onClose }: { source: AgentHome | null; onClose: () => void }) {
  const targets = useBulkMoveTargets(source?.id);
  const list = targets.data?.workstations ?? [];
  const [pick, setPick] = useState('');
  const [ack, setAck] = useState(false);
  const eff = pick || list[0]?.id || '';
  const station = list.find((w) => w.id === eff);
  const preview = useMoveAllPreview(source?.id, eff, ack);
  const move = useMoveAllAgents(source?.id ?? '');
  const result = move.data;
  const p = preview.data;
  const n = p?.moved.length ?? 0;
  const needAck = !!p?.needsUnsandboxedAck && !ack;
  const close = () => {
    move.reset();
    onClose();
  };
  return (
    <Dialog
      open={!!source}
      onOpenChange={(o) => !o && close()}
      title={`Move all agents from ${source?.name ?? ''}`}
      description="Each agent keeps its name, history, projects, runtime and model; the old sandboxes stay behind."
    >
      {source && result && (
        <div className="flex flex-col gap-3" data-testid="move-all-result">
          <p className="text-sm">
            {result.moved.length} moved to {result.target.name}
            {result.skipped.length ? `, ${result.skipped.length} skipped` : ''}
            {result.failed.length ? `, ${result.failed.length} could not move` : ''}.
          </p>
          <Lists r={result} />
          <div className="flex justify-end">
            <Button variant="primary" className="min-h-11 w-full sm:w-auto" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      )}
      {source && !result && (
        <form
          aria-label="Move all agents"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!eff || n === 0) return;
            move.mutate({ targetWorkstationId: eff, ...(ack ? { acknowledgeUnsandboxed: true } : {}) });
          }}
        >
          {targets.data && list.length === 0 ? (
            <p className="text-sm" data-testid="move-all-no-targets">
              No other workstation in this organization.{' '}
              <Link to="/workstations" className="text-brand-text hover:underline">
                Pair one on the Workstations page.
              </Link>
            </p>
          ) : (
            <Select label="Move to" value={eff} onChange={(e) => setPick(e.target.value)}>
              {list.length === 0 && <option value="">Loading workstations…</option>}
              {list.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} · {w.mine ? 'you' : w.ownerName} ({w.connected ? 'connected' : 'offline'})
                </option>
              ))}
            </Select>
          )}
          {p && (
            <div className="flex flex-col gap-3" data-testid="move-all-preview">
              <p className="text-sm font-medium" data-testid="move-all-count">
                {n} {n === 1 ? 'agent' : 'agents'} will move to {p.target.name}
              </p>
              {(p.skipped.length > 0 || p.failed.length > 0) && (
                <div className="flex flex-col gap-3">
                  {p.skipped.length > 0 && (
                    <Names title="Will be skipped" testId="move-all-preview-skipped">
                      {p.skipped.map((a) => (
                        <li key={a.agentId}>
                          {a.name}: {skipText(a)}
                        </li>
                      ))}
                    </Names>
                  )}
                  {p.failed.length > 0 && (
                    <Names title="Will not move" testId="move-all-preview-failed">
                      {p.failed.map((a) => (
                        <li key={a.agentId}>
                          {a.name}: {a.error}
                        </li>
                      ))}
                    </Names>
                  )}
                </div>
              )}
            </div>
          )}
          {(p?.needsUnsandboxedAck || ack) && station && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                className="mt-1 size-5"
              />
              <span>I understand these agents run without an OS sandbox on {station.name}</span>
            </label>
          )}
          <ErrorBox error={move.error ?? targets.error ?? preview.error} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button className="min-h-11" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              className="min-h-11"
              disabled={move.isPending || preview.isLoading || n === 0 || needAck}
            >
              {n === 1 ? 'Move 1 agent' : `Move ${n} agents`}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
