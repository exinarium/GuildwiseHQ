import {
  CONNECTABLE_FORGES,
  type ConnectableForge,
  connectCommand,
  connectSteps,
  FORGE_LABELS,
  type GitConnection,
  type WorkstationDto,
} from '@aom/shared';
import { useState } from 'react';
import { useRecheckGit } from '../api/queries/forges.ts';
import { copyText } from '../lib/secure.ts';
import { Badge, Button, ErrorBox, useToast } from './ui.tsx';

/** The connection of a workstation to a provider (the best one when several hosts are reported). */
export function connectionOf(
  w: Pick<WorkstationDto, 'git'> | undefined,
  provider: ConnectableForge,
): GitConnection | undefined {
  const list = (w?.git?.connections ?? []).filter((c) => c.provider === provider);
  return list.find((c) => c.state === 'connected') ?? list[0];
}

export function ConnectionBadge({ c }: { c: GitConnection | undefined }) {
  if (!c) return <Badge title="Not reported yet">Unknown</Badge>;
  if (c.state === 'connected')
    return (
      <Badge tone="green" {...(c.detail ? { title: c.detail } : {})}>
        {c.account ? `Connected as ${c.account}` : 'Connected'}
      </Badge>
    );
  if (c.problem === 'unreachable')
    return (
      <Badge tone="amber" {...(c.detail ? { title: c.detail } : {})}>
        Could not check
      </Badge>
    );
  if (c.state === 'unavailable') return <Badge tone="amber">Tool missing</Badge>;
  if (c.problem === 'token_refused')
    return (
      <Badge tone="amber" {...(c.detail ? { title: c.detail } : {})}>
        Token refused
      </Badge>
    );
  return (
    <Badge tone="neutral" {...(c.detail ? { title: c.detail } : {})}>
      Not connected
    </Badge>
  );
}

/**
 * The "Connect" helper: the steps and the one command to run on the workstation. Credentials are entered there and
 * stay there; this page only learns whether it worked ("Check again").
 */
export function ConnectHelper({
  provider,
  workstationId,
  host,
}: {
  provider: ConnectableForge;
  workstationId: string;
  host?: string;
}) {
  const toast = useToast();
  const recheck = useRecheckGit();
  const cmd = connectCommand(provider);
  return (
    <div
      className="mt-2 rounded-control border border-line bg-sunken p-3 text-sm"
      data-testid={`connect-${provider}`}
    >
      <p className="mb-2 font-medium text-fg">Connect {FORGE_LABELS[provider]} on this workstation</p>
      <p className="mb-2 text-muted">
        Run this in a terminal on the workstation. Your login or token stays on that machine; the server only
        learns whether it is connected. The DevOps engineer can walk you through it in chat.
      </p>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <code className="rounded bg-surface px-2 py-1 font-mono text-xs break-all">{cmd}</code>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            if (await copyText(cmd)) toast.success('Command copied');
          }}
        >
          Copy
        </Button>
      </div>
      <ol className="mb-3 list-none space-y-1 text-muted">
        {connectSteps(provider, host).map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <Button size="sm" onClick={() => recheck.mutate(workstationId)} loading={recheck.isPending}>
        Check again
      </Button>
      {recheck.isSuccess && (
        <span className="ml-2 text-xs text-subtle">Asked the workstation; this updates in a moment.</span>
      )}
      <ErrorBox error={recheck.error} />
    </div>
  );
}

/** One row per provider on the Workstations page, each with a Connect helper when it is not connected. */
export function GitConnectionsPanel({ w }: { w: WorkstationDto }) {
  const [open, setOpen] = useState<ConnectableForge | null>(null);
  return (
    <div className="mt-4 border-t border-line pt-3 text-sm" data-testid="git-connections">
      <p className="mb-2 text-xs font-medium text-subtle">Git hosts</p>
      {!w.git || w.git.connections.length === 0 ? (
        <p className="text-subtle">
          Not reported yet (needs a current runner). Run{' '}
          <code className="font-mono text-xs">aom-runner git-connect github</code> to set one up.
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {CONNECTABLE_FORGES.map((p) => {
          const c = connectionOf(w, p);
          return (
            <li key={p} data-testid={`git-${p}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-40 font-medium text-fg">{FORGE_LABELS[p]}</span>
                <ConnectionBadge c={c} />
                {c?.host &&
                  c.host !== 'github.com' &&
                  c.host !== 'gitlab.com' &&
                  c.host !== 'bitbucket.org' &&
                  c.host !== 'dev.azure.com' && (
                    <span className="font-mono text-xs text-subtle">{c.host}</span>
                  )}
                {c?.state !== 'connected' && w.connected && (
                  <Button size="sm" variant="secondary" onClick={() => setOpen(open === p ? null : p)}>
                    {open === p ? 'Hide' : 'Connect'}
                  </Button>
                )}
              </div>
              {open === p && (
                <ConnectHelper provider={p} workstationId={w.id} {...(c?.host ? { host: c.host } : {})} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
