import { Check, TriangleAlert } from 'lucide-react';
import { Button, Dialog } from '../ui.tsx';

export interface ScopeInfo {
  required: Array<{ scope: string; label: string; has: boolean }>;
  missing: string[];
}

/** What a capability says it needs, with a tick for what the agent has: shown when the capability is declared on a grant. */
export function ScopeList({ scopes, className }: { scopes: ScopeInfo['required']; className?: string }) {
  if (scopes.length === 0) return null;
  return (
    <ul className={className ?? 'flex flex-col gap-1'} data-testid="scope-list">
      {scopes.map((s) => (
        <li key={s.scope} className="flex items-center gap-2 text-sm">
          {s.has ? (
            <Check aria-hidden="true" className="size-4 text-success-text" />
          ) : (
            <TriangleAlert aria-hidden="true" className="size-4 text-warning-text" />
          )}
          <span className="text-fg">{s.label}</span>
          <span className="text-subtle">({s.scope})</span>
          <span className="sr-only">{s.has ? 'the agent has this' : 'the agent lacks this'}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Granting something that needs a scope the agent lacks: the granter sees what is missing and has to say yes, knowing that the
 * agent may not be able to do the work (or may fail halfway).
 */
export function ScopeConfirm({
  info,
  what,
  agentName,
  pending,
  onConfirm,
  onCancel,
}: {
  info: ScopeInfo | null;
  what: string;
  agentName?: string;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={!!info}
      onOpenChange={(o) => !o && onCancel()}
      title="This needs more than the agent has"
      description={`${what} needs ${info?.missing.join(', ') ?? ''}${agentName ? `, which ${agentName} does not have` : ', which the agent does not have'}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" loading={!!pending} onClick={onConfirm}>
            Grant anyway
          </Button>
        </>
      }
    >
      <ScopeList scopes={info?.required ?? []} />
      <p className="mt-3 text-sm text-muted">
        Granting it does not give the agent the missing permission. Change its role or permissions first if
        you want it to work.
      </p>
    </Dialog>
  );
}
