import {
  type DnsCheckDto,
  MOVE_STEP_TEXT,
  type MoveDto,
  type MoveStep,
  PREPARE_STEPS,
  type ProbeReport,
  type SetupEnv,
  type SetupStateDto,
  type SetupTargetDto,
  SWITCH_STEPS,
} from '@aom/shared';
import { AlertTriangle, ArrowRight, Check, Circle, Clock, Loader2, Server, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useCancelMove,
  useCompleteMove,
  useDns,
  useRetryMove,
  useStartMove,
  useSwitchMove,
} from '../../../api/queries/deploy-move.ts';
import { useProbe } from '../../../api/queries/deploy-setup.ts';
import { Badge, Button, Callout, ConfirmDialog, ErrorBox, Spinner } from '../../ui.tsx';
import { ConnectServer } from '../connect/ConnectServer.tsx';
import { CopyButton } from '../connect/CopyButton.tsx';
import { PrepareServer } from '../connect/PrepareServer.tsx';

const dirOf = (file: string) => file.slice(0, file.lastIndexOf('/')) || '/';

/** The steps in the order a person reads them, with a plain title. */
const LIST: MoveStep[] = [...PREPARE_STEPS, ...SWITCH_STEPS];

function StepList({ move }: { move: MoveDto }) {
  const done = new Map(move.steps.map((s) => [s.step, s]));
  return (
    <ol className="flex flex-col gap-1.5" data-testid="move-steps">
      {LIST.map((step) => {
        const d = done.get(step);
        const running =
          move.currentStep === step && (move.state === 'preparing' || move.state === 'moving') && !d?.ok;
        const failed = d && !d.ok;
        return (
          <li key={step} className="flex items-start gap-2 text-sm" data-testid={`move-step-${step}`}>
            <span className="mt-0.5 shrink-0">
              {failed ? (
                <X aria-hidden="true" className="size-4 text-danger" />
              ) : d?.ok ? (
                <Check aria-hidden="true" className="size-4 text-success" />
              ) : running ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin text-muted" />
              ) : (
                <Circle aria-hidden="true" className="size-4 text-subtle" />
              )}
            </span>
            <span className="min-w-0">
              <span className={d?.ok ? 'text-fg' : running ? 'font-medium text-fg' : 'text-muted'}>
                {running ? MOVE_STEP_TEXT[step].doing : MOVE_STEP_TEXT[step].title}
              </span>
              {d?.ok && d.checks[0] && step !== 'check' && (
                <span className="block text-xs text-subtle">{d.checks[0].text}</span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Checks({ move }: { move: MoveDto }) {
  const last = move.steps.find((s) => s.step === 'check');
  if (!last) return null;
  return (
    <ul className="flex flex-col gap-1" data-testid="move-checks">
      {last.checks.map((c) => (
        <li key={c.id} className="flex items-start gap-2 text-sm">
          {c.ok ? (
            <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
          ) : (
            <X aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          )}
          <span className={c.ok ? 'text-muted' : 'text-fg'}>{c.text}</span>
        </li>
      ))}
    </ul>
  );
}

const DNS_TONE = { new: 'green', old: 'amber', other: 'amber', none: 'amber', error: 'neutral' } as const;
const DNS_LABEL = {
  new: 'Points to the new server',
  old: 'Still points to the old server',
  other: 'Points somewhere else',
  none: 'Not set yet',
  error: 'Could not check',
} as const;

/**
 * Move an environment to a new server (docs/design/deploy-run-ux-design.md J6, v3). A guided, plain-language flow: choose or
 * connect the new server, let Guildwise look at it and get it ready, copy everything over while the old site keeps running,
 * agree to a short downtime, point the web address at the new server (with a live check), and make it live. The old server is
 * kept as a fallback; nothing on it is deleted.
 */
export function MoveWizard({
  projectId,
  s,
  env,
  from,
  move,
  moves,
  onClose,
}: {
  projectId: string;
  s: SetupStateDto;
  env: SetupEnv;
  from: SetupTargetDto;
  /** The open move of this environment, when there is one (the wizard follows it). */
  move: MoveDto | undefined;
  /** The finished moves (to show the last one when there is none open). */
  moves: MoveDto[];
  onClose: () => void;
}) {
  const [toId, setToId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const start = useStartMove(projectId);
  const probe = useProbe(projectId);
  const dir = dirOf(env.app.composeFile);
  const workstationId = from.workstationId ?? '';
  const candidates = s.targets.filter(
    (t) =>
      t.kind === 'remote_ssh' &&
      t.id !== from.id &&
      (t.role ?? 'active') === 'active' &&
      t.workstationId === from.workstationId &&
      !s.current.setup?.environments.some((e) => e.target === t.name),
  );
  const to = s.targets.find((t) => t.id === toId);
  const report: ProbeReport | null = useMemo(
    () =>
      (s.probes.find((p) => p.scope === 'ssh_target' && p.targetId === toId && p.report)?.report as
        | ProbeReport
        | undefined) ?? null,
    [s.probes, toId],
  );
  const looked = useRef<string | null>(null);
  useEffect(() => {
    if (toId && looked.current !== toId && !report && workstationId) {
      looked.current = toId;
      probe.mutate({ scope: 'ssh_target', targetId: toId, workstationId });
    }
  }, [toId, report, workstationId, probe]);

  // ------------------------------------------------------------------------------------------- an open (or last) move
  if (move) return <Following projectId={projectId} s={s} move={move} onClose={onClose} />;
  const last = moves.find((m) => m.envName === env.name);
  const justEnded = last && (last.state === 'cancelled' || last.state === 'completed') ? last : undefined;

  // ------------------------------------------------------------------------------------------- choosing the new server
  return (
    <div className="flex flex-col gap-4" data-testid="move-wizard" data-step={to ? 'prepare' : 'server'}>
      <p className="text-sm text-muted">
        Moving <strong className="text-fg">{env.label}</strong> from{' '}
        <strong className="text-fg">{from.name}</strong> to a new server. The old site keeps running while
        Guildwise gets the new server ready and copies everything over. Then there is a short downtime
        (usually a few minutes) while the last data moves.
      </p>
      {justEnded?.state === 'cancelled' && (
        <Callout tone="info" title="The last move was given up" data-testid="move-last-cancelled">
          The old app runs again. Nothing was deleted anywhere. You can start again below.
        </Callout>
      )}
      {!to && !connecting && (
        <section className="flex flex-col gap-2" data-testid="move-choose">
          <h4 className="text-base font-semibold text-fg">1. The new server</h4>
          {candidates.length > 0 && (
            <ul className="flex flex-col gap-2">
              {candidates.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setToId(t.id)}
                    className="flex w-full items-center gap-3 rounded-control border border-control bg-surface p-3 text-left hover:bg-sunken"
                    data-testid={`move-pick-${t.name}`}
                  >
                    <Server aria-hidden="true" className="size-4 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-fg">{t.name}</span>
                      <span className="block text-xs text-muted">
                        Already connected from {t.workstationName ?? 'this computer'}
                      </span>
                    </span>
                    <ArrowRight aria-hidden="true" className="size-4 text-subtle" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button variant="primary" onClick={() => setConnecting(true)} data-testid="move-connect-new">
              <Server aria-hidden="true" className="size-4" />
              Connect a new server
            </Button>
            <p className="mt-1 text-xs text-subtle">
              You need its address and the user name and password your hosting company gave you.
            </p>
          </div>
        </section>
      )}
      {connecting && !to && (
        <ConnectServer
          heading={false}
          projectId={projectId}
          production={false}
          prefill={{ name: `${from.name} (new server)` }}
          onCancel={() => setConnecting(false)}
          onDone={(c) => {
            setConnecting(false);
            setToId(c.targetId);
          }}
        />
      )}

      {to && (
        <section className="flex flex-col gap-3" data-testid="move-prepare">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-base font-semibold text-fg">2. Get {to.name} ready</h4>
            <Badge tone="green">Connected</Badge>
            <Button size="sm" variant="ghost" onClick={() => setToId(null)} data-testid="move-change-server">
              Choose another
            </Button>
          </div>
          {to.workstationId !== from.workstationId && (
            <Callout tone="warning" title="Another computer" data-testid="move-other-computer">
              The same computer has to sign in to both servers. {to.name} is connected from{' '}
              {to.workstationName ?? 'another computer'}; {from.name} from{' '}
              {from.workstationName ?? 'this one'}. Reconnect one of them from the same computer first.
            </Callout>
          )}
          {!report && (
            <div
              className="flex items-center gap-2 text-sm text-muted"
              role="status"
              data-testid="move-looking"
            >
              <Spinner inline label="Looking" />
              Looking at {to.name}...
            </div>
          )}
          {report && (
            <>
              <PrepareServer
                projectId={projectId}
                hosting="ssh"
                workstationId={workstationId}
                targetId={to.id}
                report={report}
                suggestedName={to.name}
                fixed={{ dir }}
                onPrepared={() => {
                  setPrepared(true);
                  probe.mutate({ scope: 'ssh_target', targetId: to.id, workstationId });
                }}
              />
              {report.docker?.installed && report.docker.usable ? (
                <p className="text-xs text-subtle">
                  Guildwise copies the app, its settings and its data from {from.name} in the next steps; it
                  never writes over a file that is already on the new server.
                </p>
              ) : (
                <Callout tone="warning" title="Docker is needed" data-testid="move-needs-docker">
                  The new server needs Docker. Use “Set it up” above, then look again.
                </Callout>
              )}
            </>
          )}
          <ErrorBox error={start.error} />
          <div className="sticky bottom-[var(--app-bottom-inset,0px)] z-10 -mx-4 flex gap-2 border-t border-line bg-surface px-4 py-3 sm:mx-0">
            <Button onClick={onClose}>Close</Button>
            <Button
              variant="primary"
              className="flex-1 sm:flex-none"
              disabled={
                !report ||
                !report.docker?.installed ||
                !report.docker.usable ||
                to.workstationId !== from.workstationId ||
                start.isPending
              }
              loading={start.isPending}
              onClick={() => start.mutate({ fromTargetId: from.id, toTargetId: to.id, workstationId })}
              data-testid="move-start"
            >
              Look at both servers and copy
            </Button>
          </div>
          {prepared && <span className="sr-only">Prepared</span>}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- following a move

function Following({
  projectId,
  s,
  move,
  onClose,
}: {
  projectId: string;
  s: SetupStateDto;
  move: MoveDto;
  onClose: () => void;
}) {
  const sw = useSwitchMove(projectId);
  const retry = useRetryMove(projectId);
  const cancel = useCancelMove(projectId);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const failedBlocked = move.state === 'failed' && move.currentStep === 'check';
  const working = move.state === 'preparing' || move.state === 'moving';

  return (
    <div className="flex flex-col gap-4" data-testid="move-wizard" data-step={`move-${move.state}`}>
      <p className="text-sm text-muted">
        Moving <strong className="text-fg">{move.fromName}</strong> to{' '}
        <strong className="text-fg">{move.toName}</strong> with {move.workstationName}.
      </p>

      {move.state !== 'app_ready' && move.state !== 'completed' && <StepList move={move} />}
      {working && (
        <p className="flex items-center gap-2 text-sm text-muted" role="status" data-testid="move-working">
          <Spinner inline label="Working" />
          {move.state === 'moving'
            ? 'The data is moving. The old site is down until the new app answers.'
            : 'Nothing is changed on the old server in this part.'}
        </p>
      )}

      {move.state === 'failed' && (
        <section className="flex flex-col gap-2" data-testid="move-failed">
          <Callout tone="danger" title="This stopped">
            {move.error}
          </Callout>
          {failedBlocked && <Checks move={move} />}
          {move.oldAppStopped ? (
            <Callout tone="warning" title="The old site is down" data-testid="move-old-down">
              The app on the old server is still stopped. Try again, or go back to the old server: that starts
              it again.
            </Callout>
          ) : (
            <p className="text-sm text-muted" data-testid="move-old-up">
              The old site is running as before. Nothing was lost.
            </p>
          )}
          <ErrorBox error={retry.error ?? cancel.error} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              loading={retry.isPending}
              onClick={() => retry.mutate(move.id)}
              data-testid="move-retry"
            >
              Try again
            </Button>
            <Button onClick={() => setConfirmCancel(true)} data-testid="move-give-up">
              {move.oldAppStopped ? 'Go back to the old server' : 'Give up the move'}
            </Button>
          </div>
        </section>
      )}

      {move.state === 'ready' && (
        <section className="flex flex-col gap-3" data-testid="move-ready">
          <Callout tone="success" title={`${move.toName} is ready`}>
            Everything is copied except the data, and nothing has changed on {move.fromName} yet.
          </Callout>
          <div className="rounded-control border border-line p-3">
            <p className="text-sm font-medium text-fg">What happens next: a short downtime</p>
            <ol className="mt-1 list-decimal pl-5 text-sm text-muted">
              <li>The app on {move.fromName} is stopped (its database keeps running).</li>
              <li>A last backup is saved on {move.fromName}, and kept there.</li>
              <li>The data is put on {move.toName}.</li>
              <li>The app is started on {move.toName} and checked.</li>
            </ol>
            <p className="mt-2 text-sm text-muted" data-testid="move-downtime-text">
              While this runs, visitors cannot use the site. It usually takes a few minutes; a big database
              takes longer. If something goes wrong, Guildwise tells you and the old app can be started again.
            </p>
          </div>
          <ErrorBox error={sw.error} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              loading={sw.isPending}
              onClick={() => sw.mutate(move.id)}
              data-testid="move-switch"
            >
              <Clock aria-hidden="true" className="size-4" />A short downtime is fine: move now
            </Button>
            <Button variant="ghost" onClick={() => setConfirmCancel(true)} data-testid="move-not-now">
              Not now
            </Button>
          </div>
        </section>
      )}

      {move.state === 'app_ready' && (
        <LiveStep projectId={projectId} s={s} move={move} onAskBack={() => setConfirmCancel(true)} />
      )}

      {move.state === 'completed' && (
        <section className="flex flex-col gap-2" data-testid="move-done">
          <Callout tone="success" title={`${move.toName} is live`}>
            Deploys go to the new server from now on. {move.fromName} is kept as a fallback (“standby”):
            nothing was deleted there, and its backup from the move is still on it. When you are sure, the
            Owner can retire it from the deploy overview.
          </Callout>
          <div>
            <Button variant="primary" onClick={onClose} data-testid="move-close">
              Done
            </Button>
          </div>
        </section>
      )}

      {working && (
        <div>
          <Button size="sm" variant="ghost" onClick={onClose} data-testid="move-hide">
            Close (it keeps going)
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={
          move.oldAppStopped || move.state === 'app_ready'
            ? 'Go back to the old server?'
            : 'Give up the move?'
        }
        confirmLabel={
          move.oldAppStopped || move.state === 'app_ready' ? 'Start the old app again' : 'Give up'
        }
        tone="primary"
        pending={cancel.isPending}
        onConfirm={() => cancel.mutate(move.id, { onSuccess: () => setConfirmCancel(false) })}
      >
        <p className="text-sm text-muted">
          {move.oldAppStopped || move.state === 'app_ready'
            ? `The app on ${move.toName} is stopped and the app on ${move.fromName} is started again. Nothing is deleted. Anything written on ${move.toName} meanwhile is not copied back.`
            : 'Nothing was changed on the old server. The copies on the new server stay there; nothing is deleted.'}
        </p>
      </ConfirmDialog>
    </div>
  );
}

/** The new app answers: point the address, check it live, make it live. */
function LiveStep({
  projectId,
  s,
  move,
  onAskBack,
}: {
  projectId: string;
  s: SetupStateDto;
  move: MoveDto;
  onAskBack: () => void;
}) {
  const dns = useDns(projectId, move.id, !!move.domain);
  const complete = useCompleteMove(projectId);
  const probe = useProbe(projectId);
  const [other, setOther] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const dnsData: DnsCheckDto | undefined = dns.data;
  const dnsOk = dnsData?.state === 'new';
  const to = s.targets.find((t) => t.id === move.toTargetId);
  const report = (s.probes.find((p) => p.scope === 'ssh_target' && p.targetId === move.toTargetId && p.report)
    ?.report ?? null) as ProbeReport | null;
  const asked = useRef(false);
  useEffect(() => {
    if (!asked.current && move.domain) {
      asked.current = true;
      probe.mutate({ scope: 'ssh_target', targetId: move.toTargetId, workstationId: move.workstationId });
    }
  }, [move, probe]);
  const dir = dirOf(
    String(
      s.current.setup?.environments.find((e) => e.name === move.envName)?.app.composeFile ?? '/opt/app/x',
    ),
  );

  return (
    <section className="flex flex-col gap-4" data-testid="move-live">
      <Callout tone="success" title={`The app on ${move.toName} is running and answers`}>
        The data is on {move.toName}. {move.fromName} is stopped, with its last backup kept on it.
      </Callout>

      {move.domain ? (
        <div className="flex flex-col gap-3" data-testid="move-dns">
          {report && (
            <PrepareServer
              projectId={projectId}
              hosting="ssh"
              workstationId={move.workstationId}
              targetId={move.toTargetId}
              report={report}
              suggestedName={to?.name ?? 'server'}
              title={`1. Set up HTTPS for ${move.domain} on ${move.toName}`}
              intro="Guildwise adds the address to the web server on the new server (Caddy). Other sites and settings stay as they are."
              fixed={{ dir, domain: move.domain, port: move.facts.appPort ?? 4600 }}
              onPrepared={() =>
                probe.mutate({
                  scope: 'ssh_target',
                  targetId: move.toTargetId,
                  workstationId: move.workstationId,
                })
              }
            />
          )}
          <h4 className="text-base font-semibold text-fg">2. Point {move.domain} to the new server</h4>
          <p className="text-sm text-muted">
            At the company that manages <strong className="text-fg">{move.domain}</strong> (where you bought
            the name), change the address the name points to:
          </p>
          <div className="flex flex-wrap items-center gap-2 rounded-control border border-line p-3 text-sm">
            <span className="text-muted">Point</span>
            <code className="rounded bg-sunken px-1.5 py-0.5" data-testid="move-dns-domain">
              {move.domain}
            </code>
            <span className="text-muted">to</span>
            <code className="rounded bg-sunken px-1.5 py-0.5" data-testid="move-dns-address">
              {move.newAddresses.join(' or ') || '(the address of the new server)'}
            </code>
            {move.newAddresses[0] && (
              <CopyButton text={move.newAddresses[0]} label="Copy the address" testId="move-dns-copy" />
            )}
          </div>
          <p className="text-xs text-subtle">
            In the DNS settings this is the “A record” of {move.domain}. A change can take a few minutes,
            sometimes hours, to spread.
          </p>
          <div
            className="flex flex-col gap-2 rounded-control border border-line p-3"
            data-testid="move-dns-live"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-fg">Live check</span>
              {dnsData ? (
                <Badge tone={DNS_TONE[dnsData.state]} data-testid="move-dns-state">
                  {DNS_LABEL[dnsData.state]}
                </Badge>
              ) : (
                <Spinner inline label="Checking" />
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void dns.refetch()}
                data-testid="move-dns-again"
              >
                Check again
              </Button>
            </div>
            {dnsData && (
              <p className="text-sm text-muted" data-testid="move-dns-text">
                {dnsData.text}
              </p>
            )}
            {dnsData && dnsData.found.length > 0 && (
              <p className="text-xs text-subtle">It points to {dnsData.found.join(', ')} now.</p>
            )}
          </div>
          <label className="flex items-start gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={other}
              onChange={(e) => setOther(e.target.checked)}
              className="mt-1"
              data-testid="move-dns-other"
            />
            <span>
              I handle the web address another way (for example a service in front of the server). Make it
              live without this check.
            </span>
          </label>
        </div>
      ) : (
        <p className="text-sm text-muted" data-testid="move-no-domain">
          This app has no web name Guildwise could use (it is reached by an address with numbers or by a name
          only on this network), so there is no domain to point. Make sure whatever reaches the old server
          reaches the new one.
        </p>
      )}

      <ErrorBox error={complete.error} />
      {!s.canApprove && (
        <Callout tone="info" title="Waiting for the Owner" data-testid="move-owner-only">
          Only the Owner of the organization makes the new server live.
        </Callout>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={!s.canApprove || !(dnsOk || other || !move.domain)}
          onClick={() => setConfirm(true)}
          data-testid="move-golive"
        >
          <Check aria-hidden="true" className="size-4" />
          Make {move.toName} live
        </Button>
        <Button variant="ghost" onClick={onAskBack} data-testid="move-back">
          Go back to the old server
        </Button>
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Make ${move.toName} live?`}
        confirmLabel="Make it live"
        tone="primary"
        pending={complete.isPending}
        onConfirm={() =>
          complete.mutate(
            { moveId: move.id, dns: dnsOk && !other ? 'verified' : 'unverified' },
            { onSuccess: () => setConfirm(false) },
          )
        }
      >
        <div className="flex flex-col gap-2 text-sm text-muted">
          <p>From now on:</p>
          <ul className="list-disc pl-5">
            <li>
              Deploys of {move.envName} go to {move.toName}.
            </li>
            <li>
              {move.fromName} becomes the <strong>standby</strong>: a fallback that nothing deploys to.
              Nothing is deleted on it.
            </li>
            <li>You can retire the standby later; that only removes the keys Guildwise added to it.</li>
          </ul>
          {!dnsOk && (
            <p className="flex items-start gap-2 text-warning" data-testid="move-golive-warning">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              The domain has not been seen pointing to the new server.
            </p>
          )}
        </div>
      </ConfirmDialog>
    </section>
  );
}
