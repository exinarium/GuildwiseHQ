import type { WorkstationDto } from '@aom/shared';
import { Server } from 'lucide-react';
import { useState } from 'react';
import { usePairingCode, useUnlinkWorkstation, useWorkstations } from '../api/queries/workstations.ts';
import { DevOpsPanel } from '../components/DevOpsPanel.tsx';
import { SandboxUnavailable, SandboxWarning } from '../components/SandboxWarning.tsx';
import {
  Badge,
  Button,
  ConnectionDot,
  Dialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Panel,
  useToast,
} from '../components/ui.tsx';
import { unavailableRuntimes, unsandboxedConsequence, unsandboxedRuntimes } from '../lib/sandbox.ts';
import { copyText } from '../lib/secure.ts';
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
        sub="The machines that run your agents."
        actions={
          <Button variant="primary" onClick={() => setPairOpen(true)}>
            Pair workstation
          </Button>
        }
      />
      {q.isPending && <ListSkeleton label="Loading workstations" rows={2} />}
      {q.isError && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data?.length === 0 && (
        <EmptyState
          icon={Server}
          title="No workstations paired"
          description="A workstation is a machine of yours that runs the agents. Pair one with a one-time code and the aom-runner command."
          action={
            <Button variant="primary" onClick={() => setPairOpen(true)}>
              Pair workstation
            </Button>
          }
        />
      )}
      <ul className="flex flex-col gap-3">
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
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  return (
    <li data-testid={`workstation-${w.name}`}>
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-lg font-semibold text-fg">{w.name}</p>
            <p className="text-sm text-muted">
              {[w.platform, w.hostname, w.runnerVersion && `runner ${w.runnerVersion}`]
                .filter(Boolean)
                .join(' · ')}
              {w.ownerEmail && ` · ${w.ownerEmail}`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionDot connected={w.connected} />
            <Button
              variant="danger-ghost"
              size="sm"
              aria-label={`Unlink ${w.name}`}
              onClick={() => setConfirm(true)}
            >
              Unlink
            </Button>
          </div>
        </div>
        {unsandboxedRuntimes(w.runtimes).map((r) => (
          <div key={r.id} className="mt-2" data-testid={`sandbox-warning-${r.id}`}>
            <SandboxWarning testId="sandbox-warning">
              The {r.id} runtime on {w.name} runs agents without an OS sandbox
              {r.sandboxReason ? ` (${r.sandboxReason})` : ''}: {unsandboxedConsequence(r.sandboxReason)}
            </SandboxWarning>
          </div>
        ))}
        {unavailableRuntimes(w.runtimes).map((r) => (
          <div key={r.id} className="mt-2">
            <SandboxUnavailable runtime={r.id} reason={r.sandboxReason} />
          </div>
        ))}
        <div className="mt-4 grid gap-4 border-t border-line pt-3 text-sm text-fg sm:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-medium text-subtle">Runtimes</p>
            <p className="flex flex-wrap gap-1">
              {w.runtimes.length === 0 && <span className="text-subtle">None reported</span>}
              {w.runtimes.map((r) => (
                <Badge key={r.id} tone={r.available ? 'green' : 'neutral'}>
                  {r.id} {r.version}
                </Badge>
              ))}
            </p>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-subtle">Shifts running</p>
            <p
              data-testid="workstation-shifts"
              title="Set maxConcurrentShifts in the runner config.json (default 4)"
            >
              {w.shifts
                ? w.shifts.limit
                  ? `${w.shifts.running} of ${w.shifts.limit}`
                  : `${w.shifts.running} (limit shown while connected)`
                : 'Not reported'}
            </p>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-subtle">Repositories</p>
            <ul data-testid="workstation-repos">
              {w.repos.length === 0 && <li className="text-subtle">None reported</li>}
              {w.repos.map((r) => (
                <li key={r.projectRepoId} className="font-mono text-xs break-all">
                  {r.localPath}
                </li>
              ))}
            </ul>
          </div>
        </div>
        {w.lastSeenAt && <p className="mt-1 text-xs text-subtle">Last seen {formatDateTime(w.lastSeenAt)}</p>}
        {!admin && <DevOpsPanel w={w} />}
        <ErrorBox error={unlink.error} />
      </Panel>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Unlink ${w.name}?`}
        description="Agents on this workstation will be released and its runner token stops working."
      >
        <ul className="mb-4 list-disc pl-5 text-sm text-muted">
          <li>Its agents are released and their cards go back to the queue.</li>
          <li>The runner token stops working; pair the machine again to use it later.</li>
        </ul>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end [&>button]:max-sm:w-full">
          <Button onClick={() => setConfirm(false)}>Cancel</Button>
          <Button
            variant="danger"
            loading={unlink.isPending}
            onClick={() =>
              unlink.mutate(w.id, {
                onSuccess: () => {
                  setConfirm(false);
                  toast.success(`${w.name} unlinked`);
                },
              })
            }
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
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const code = gen.data?.code;
  const cmd = code ? pairCommand(code) : '';
  const copy = async () => {
    const ok = await copyText(cmd);
    setCopied(ok);
    if (ok) toast.success('Command copied');
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
        <div className="flex flex-col gap-4">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>Generate a one-time code.</li>
            <li>Run the command it shows on the machine that will host your agents.</li>
            <li>Wait for the connection: this page updates when the runner connects.</li>
          </ol>
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
          <p
            className="rounded-card bg-sunken py-4 text-center font-mono text-3xl font-semibold tracking-widest text-fg"
            data-testid="pairing-code"
          >
            {code}
          </p>
          <p className="text-sm text-muted">Expires {formatDateTime(gen.data?.expiresAt)}. Shown once.</p>
          <pre
            data-testid="pair-command"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard reachable
            tabIndex={0}
            className="overflow-x-auto rounded-control bg-side p-2 font-mono text-xs text-side-strong"
          >
            {cmd}
          </pre>
          <Button onClick={copy} className="self-start">
            {copied ? 'Copied' : 'Copy command'}
          </Button>
          <p className="text-xs text-subtle">
            Then run <code className="font-mono">aom-runner start</code>. This page updates when it connects.
          </p>
        </div>
      )}
    </Dialog>
  );
}
