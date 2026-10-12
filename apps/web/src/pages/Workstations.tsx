import type { WorkstationDto } from '@aom/shared';
import { ChevronRight, Server, TriangleAlert } from 'lucide-react';
import { useCallback, useId, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMe } from '../api/queries/auth.ts';
import { usePairingCode, useUnlinkWorkstation, useWorkstations } from '../api/queries/workstations.ts';
import { BRAND } from '../brand.ts';
import { DevOpsPanel } from '../components/DevOpsPanel.tsx';
import { GitConnectionsPanel } from '../components/GitConnections.tsx';
import { SandboxUnavailable, SandboxWarning } from '../components/SandboxWarning.tsx';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  ConnectionDot,
  Dialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Panel,
  useToast,
} from '../components/ui.tsx';
import { AddWorkstationWizard } from '../components/workstations/AddWorkstationWizard.tsx';
import { CloudWorkstations } from '../components/workstations/CloudWorkstations.tsx';
import { RunnerUpdateBadge } from '../components/workstations/RunnerUpdateBadge.tsx';
import { useCanManageOrg } from '../lib/orgRole.ts';
import { unavailableRuntimes, unsandboxedConsequence, unsandboxedRuntimes } from '../lib/sandbox.ts';
import { copyText } from '../lib/secure.ts';
import { formatDateTime } from '../lib/time.ts';

/** Which workstation rows the user has expanded, remembered per user in this browser (never required: storage may be blocked). */
function useOpenRows(userId: string | undefined): [Set<string>, (id: string, open: boolean) => void] {
  const key = `${BRAND.storagePrefix}-workstations-open-${userId ?? 'anon'}`;
  const read = useCallback((): Set<string> => {
    try {
      const raw = localStorage.getItem(key);
      const list: unknown = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  }, [key]);
  const [open, setOpen] = useState<Set<string>>(read);
  const [forKey, setForKey] = useState(key);
  if (forKey !== key) {
    setForKey(key);
    setOpen(read());
  }
  const set = (id: string, on: boolean) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        /* storage blocked: the row still opens for this page */
      }
      return next;
    });
  return [open, set];
}

export function pairCommand(code: string, origin: string = location.origin): string {
  return `aom-runner pair --server ${origin} --code ${code} --name "My workstation"`;
}

export function Workstations() {
  const q = useWorkstations();
  const me = useMe();
  const canManageCloud = useCanManageOrg();
  const [open, setOpen] = useOpenRows(me.data?.user.id);
  const [pairOpen, setPairOpen] = useState(false);
  const [params] = useSearchParams();
  const [addOpen, setAddOpen] = useState(() => params.get('add') === '1');
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Workstations"
        sub="The machines that run your agents."
        actions={
          <>
            <Button variant="secondary" onClick={() => setPairOpen(true)}>
              Pair workstation
            </Button>
            <Button variant="primary" data-testid="add-workstation-button" onClick={() => setAddOpen(true)}>
              Add a workstation
            </Button>
          </>
        }
      />
      {me.data?.activeOrg?.simulation && (
        <div className="mb-4">
          <Callout tone="warning" role="status" data-testid="simulation-workstations-note">
            This is a simulation organization. Its agents run on the <strong>Simulated workstation</strong>,
            which Guildwise hosts. Your own workstations do not receive any work from it.
          </Callout>
        </div>
      )}
      {q.isPending && <ListSkeleton label="Loading workstations" rows={2} />}
      {q.isError && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data?.length === 0 && (
        <EmptyState
          icon={Server}
          title="No workstations paired"
          description="A workstation is a computer of yours that runs your agents. The guided setup installs everything for you and connects it to your account."
          data-testid="workstations-empty"
          action={
            <Button variant="primary" data-testid="add-workstation-empty" onClick={() => setAddOpen(true)}>
              Add a workstation
            </Button>
          }
          secondaryAction={
            <Button variant="ghost" onClick={() => setPairOpen(true)}>
              Pair with a code
            </Button>
          }
        />
      )}
      <CloudWorkstations canManage={canManageCloud} />
      <ul className="flex flex-col gap-3">
        {q.data
          ?.filter((w) => w.status === 'active')
          .map((w) => (
            <WorkstationCard
              key={w.id}
              w={w}
              expanded={open.has(w.id)}
              onExpandedChange={(v) => setOpen(w.id, v)}
            />
          ))}
      </ul>
      <AddWorkstationWizard
        open={addOpen}
        onOpenChange={setAddOpen}
        onPairWithCode={() => setPairOpen(true)}
      />
      <PairDialog open={pairOpen} onOpenChange={setPairOpen} />
    </div>
  );
}

export function WorkstationCard({
  w,
  admin = false,
  expanded: expandedProp,
  onExpandedChange,
}: {
  w: WorkstationDto & { ownerEmail?: string };
  admin?: boolean;
  /** Controlled by the page (remembered per user); a card used alone keeps its own state, collapsed at first. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const unpair = useUnlinkWorkstation();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [own, setOwn] = useState(false);
  const expanded = expandedProp ?? own;
  const setExpanded = (v: boolean) => (onExpandedChange ? onExpandedChange(v) : setOwn(v));
  const bodyId = useId();
  const warnings = unsandboxedRuntimes(w.runtimes).length + unavailableRuntimes(w.runtimes).length;
  return (
    <li data-testid={`workstation-${w.name}`}>
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            data-testid="workstation-toggle"
            aria-expanded={expanded}
            aria-controls={bodyId}
            aria-label={`${expanded ? 'Hide' : 'Show'} details of ${w.name}`}
            onClick={() => setExpanded(!expanded)}
            className="group -m-1 flex min-w-0 flex-1 items-center gap-2 rounded-control p-1 text-left focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
          >
            <ChevronRight
              aria-hidden="true"
              className={`size-4 shrink-0 text-subtle transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
            <span className="min-w-0">
              <span className="block text-lg font-semibold text-fg">{w.name}</span>
              <span className="block text-sm text-muted">
                {[w.platform, w.hostname, w.runnerVersion && `runner ${w.runnerVersion}`]
                  .filter(Boolean)
                  .join(' · ')}
                {w.ownerEmail && ` · ${w.ownerEmail}`}
              </span>
            </span>
          </button>
          <div className="flex items-center gap-3">
            <RunnerUpdateBadge update={w.runnerUpdate} />
            {!expanded && warnings > 0 && (
              <Badge
                tone="amber"
                title="A runtime on this workstation has a sandbox warning. Show the details."
              >
                <TriangleAlert aria-hidden="true" className="mr-1 size-3" />
                {warnings} {warnings === 1 ? 'warning' : 'warnings'}
              </Badge>
            )}
            {!expanded && w.shifts && (
              <span className="hidden text-xs text-subtle sm:inline">
                {w.shifts.running} {w.shifts.running === 1 ? 'shift' : 'shifts'} running
              </span>
            )}
            <ConnectionDot connected={w.connected} />
            <Button
              variant="danger-ghost"
              size="sm"
              aria-label={`Unpair ${w.name}`}
              onClick={() => setConfirm(true)}
            >
              Unpair
            </Button>
          </div>
        </div>
        {expanded && (
          <div id={bodyId} data-testid="workstation-details">
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
            {w.lastSeenAt && (
              <p className="mt-1 text-xs text-subtle">Last seen {formatDateTime(w.lastSeenAt)}</p>
            )}
            {!admin && <GitConnectionsPanel w={w} />}
            {!admin && <DevOpsPanel w={w} />}
            <ErrorBox error={unpair.error} />
          </div>
        )}
      </Panel>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Unpair ${w.name}?`}
        description="The machine stops working for you: its runner token is revoked and its runner shuts down."
        confirmLabel="Unpair"
        pending={unpair.isPending}
        onConfirm={() =>
          unpair.mutate(w.id, {
            onSuccess: () => {
              setConfirm(false);
              toast.success(`${w.name} unpaired`);
            },
          })
        }
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>Its runner token stops working. The runner exits with a message that it was unpaired.</li>
          <li>Cards claimed there go back to the queue and its running shifts stop.</li>
          <li>DevOps requests waiting for it fail with that reason.</li>
          <li>Its agents wait until you re-home them. To use the machine again, pair it with a new code.</li>
        </ul>
        <ErrorBox error={unpair.error} />
      </ConfirmDialog>
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
