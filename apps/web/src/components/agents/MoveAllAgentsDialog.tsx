import type { MoveAllAgentsResponse, MoveBlockReason } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useBulkMoveTargets, useMoveAllAgents, useMoveAllPreview } from '../../api/queries/agent-move.ts';
import { Button, Dialog, ErrorBox, Select } from '../ui.tsx';

/** The workstation the agents are moved off: a workstation card, a homes row or an agent's workstation. */
export interface MoveAllSource {
  id: string;
  name: string;
}

const REASON_LABEL: Record<MoveBlockReason, string> = {
  running_shift: 'In a running shift',
  one_devops: 'One DevOps engineer per workstation',
  workstation_limit: 'Workstation limit reached',
  sandbox_gate: 'Sandbox',
  runtime_missing: 'Runtime missing on the target',
  ceo: 'The CEO moves on the CEO page',
  other: 'Cannot move',
};

type Blocked = MoveAllAgentsResponse['blocked'][number];

function Names({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <div data-testid={testId}>
      <p className="text-sm font-medium">{title}</p>
      <ul className="mt-1 flex max-h-[50vh] list-disc flex-col gap-1 overflow-auto pl-5 text-sm">{children}</ul>
    </div>
  );
}

const claimsText = (refs: string[]) => (refs.length > 0 ? ` (releases ${refs.join(', ')})` : '');

function BlockedList({
  title,
  testId,
  list,
  onMoveOne,
}: {
  title: string;
  testId: string;
  list: Blocked[];
  onMoveOne?: (agentId: string) => void;
}) {
  return (
    <Names title={`${title} (${list.length})`} testId={testId}>
      {list.map((a) => (
        <li key={a.agentId}>
          <span className="font-medium">{a.name}</span>
          <span className="text-subtle"> · {REASON_LABEL[a.reason]}</span>
          <span className="block text-subtle">{a.message}</span>
          {onMoveOne && (
            <Button
              size="sm"
              className="mt-1 min-h-11 w-full sm:min-h-0 sm:w-auto"
              aria-label={`Move ${a.name} on its own`}
              onClick={() => onMoveOne(a.agentId)}
            >
              Move…
            </Button>
          )}
        </li>
      ))}
    </Names>
  );
}

/**
 * Moves the agents of one workstation (usually offline or removed) to another: pick the target, see for each agent whether
 * it will move or is blocked and why, confirm, then see who moved and who did not.
 */
export function MoveAllAgentsDialog({
  source,
  onClose,
  onMoveOne,
}: {
  source: MoveAllSource | null;
  onClose: () => void;
  /** Moves one blocked agent on its own (runtime and model can be changed there). */
  onMoveOne?: (agentId: string) => void;
}) {
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
  const again = () => {
    move.reset();
    setPick('');
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
            {result.blocked.length ? `, ${result.blocked.length} not moved` : ''}.
          </p>
          {result.moved.length > 0 && (
            <Names title={`Moved (${result.moved.length})`} testId="move-all-moved">
              {result.moved.map((a) => (
                <li key={a.agentId}>
                  {a.name}
                  {claimsText(a.releasedClaims)}
                </li>
              ))}
            </Names>
          )}
          {result.blocked.length > 0 && (
            <BlockedList
              title="Not moved"
              testId="move-all-not-moved"
              list={result.blocked}
              {...(onMoveOne ? { onMoveOne } : {})}
            />
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {result.blocked.length > 0 && (
              <Button className="min-h-11 w-full sm:w-auto" onClick={again}>
                Move the rest to another workstation
              </Button>
            )}
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
              {p.scope === 'own' && (
                <p className="text-sm text-subtle" data-testid="move-all-own-note">
                  Only the agents you hired are listed.
                </p>
              )}
              <p className="text-sm font-medium" data-testid="move-all-count">
                {n} {n === 1 ? 'agent' : 'agents'} will move to {p.target.name}
              </p>
              {p.moved.length > 0 && (
                <Names title={`Will move (${p.moved.length})`} testId="move-all-preview-moved">
                  {p.moved.map((a) => (
                    <li key={a.agentId}>
                      {a.name}
                      {claimsText(a.releasedClaims)}
                    </li>
                  ))}
                </Names>
              )}
              {p.blocked.length > 0 && (
                <BlockedList title="Blocked" testId="move-all-preview-blocked" list={p.blocked} />
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
