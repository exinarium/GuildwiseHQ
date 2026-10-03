import type { WorkstationDto } from '@aom/shared';
import { useState } from 'react';
import { usePairingCode, useUnlinkWorkstation, useWorkstations } from '../api/queries/workstations.ts';
import {
  Badge,
  Button,
  ConnectionDot,
  Dialog,
  ErrorBox,
  PageHeader,
  Panel,
  Spinner,
} from '../components/ui.tsx';
import { formatDateTime } from '../lib/time.ts';

export function pairCommand(code: string, origin: string = location.origin): string {
  return `aom-runner pair --server ${origin} --code ${code} --name "My workstation"`;
}

export function Workstations() {
  const q = useWorkstations();
  const [pairOpen, setPairOpen] = useState(false);
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Workstations"
        actions={
          <Button variant="primary" onClick={() => setPairOpen(true)}>
            Pair workstation
          </Button>
        }
      />
      {q.isPending && <Spinner />}
      {q.isError && <ErrorBox error={q.error} />}
      {q.data?.length === 0 && (
        <Panel>
          <p className="text-sm text-zinc-500">
            No workstations paired. Pair one to run agents on your machine.
          </p>
        </Panel>
      )}
      <ul className="flex flex-col gap-2">
        {q.data
          ?.filter((w) => w.status === 'active')
          .map((w) => (
            <WorkstationCard key={w.id} w={w} />
          ))}
      </ul>
      <PairDialog open={pairOpen} onOpenChange={setPairOpen} />
    </div>
  );
}

export function WorkstationCard({
  w,
  admin = false,
}: {
  w: WorkstationDto & { ownerEmail?: string };
  admin?: boolean;
}) {
  const unlink = useUnlinkWorkstation(admin);
  const [confirm, setConfirm] = useState(false);
  return (
    <li data-testid={`workstation-${w.name}`}>
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium">{w.name}</p>
            <p className="text-xs text-zinc-500">
              {[w.platform, w.hostname, w.runnerVersion && `runner ${w.runnerVersion}`]
                .filter(Boolean)
                .join(' · ')}
              {w.ownerEmail && ` · ${w.ownerEmail}`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionDot connected={w.connected} />
            <Button variant="ghost" aria-label={`Unlink ${w.name}`} onClick={() => setConfirm(true)}>
              Unlink
            </Button>
          </div>
        </div>
        <div className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-zinc-500">Runtimes</p>
            <p className="flex flex-wrap gap-1">
              {w.runtimes.length === 0 && <span className="text-zinc-500">None reported</span>}
              {w.runtimes.map((r) => (
                <Badge key={r.id} tone={r.available ? 'green' : 'neutral'}>
                  {r.id} {r.version}
                </Badge>
              ))}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-zinc-500">Repositories</p>
            <ul data-testid="workstation-repos">
              {w.repos.length === 0 && <li className="text-zinc-500">None reported</li>}
              {w.repos.map((r) => (
                <li key={r.projectRepoId} className="font-mono text-xs break-all">
                  {r.localPath}
                </li>
              ))}
            </ul>
          </div>
        </div>
        {w.lastSeenAt && (
          <p className="mt-1 text-xs text-zinc-500">Last seen {formatDateTime(w.lastSeenAt)}</p>
        )}
        <ErrorBox error={unlink.error} />
      </Panel>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Unlink ${w.name}?`}
        description="Agents on this workstation will be released and its runner token stops working."
      >
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirm(false)}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => unlink.mutate(w.id, { onSuccess: () => setConfirm(false) })}
          >
            Confirm unlink
          </Button>
        </div>
      </Dialog>
    </li>
  );
}

function PairDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const gen = usePairingCode();
  const [copied, setCopied] = useState(false);
  const code = gen.data?.code;
  const cmd = code ? pairCommand(code) : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          gen.reset();
          setCopied(false);
        }
      }}
      title="Pair workstation"
      description="Generate a one-time code, then run the command on the machine that will host your agents."
    >
      {!code && (
        <div className="flex flex-col gap-3">
          <ErrorBox error={gen.error} />
          <Button
            variant="primary"
            onClick={() => gen.mutate()}
            disabled={gen.isPending}
            className="self-start"
          >
            Generate pairing code
          </Button>
        </div>
      )}
      {code && (
        <div className="flex flex-col gap-3">
          <p className="text-center font-mono text-2xl tracking-widest" data-testid="pairing-code">
            {code}
          </p>
          <p className="text-xs text-zinc-500">Expires {formatDateTime(gen.data?.expiresAt)}. Shown once.</p>
          <pre
            data-testid="pair-command"
            className="overflow-x-auto rounded-md bg-zinc-950 p-2 font-mono text-xs text-zinc-100"
          >
            {cmd}
          </pre>
          <Button onClick={copy} className="self-start">
            {copied ? 'Copied' : 'Copy command'}
          </Button>
          <p className="text-xs text-zinc-500">
            Then run <code>aom-runner start</code>. This page updates when it connects.
          </p>
        </div>
      )}
    </Dialog>
  );
}
