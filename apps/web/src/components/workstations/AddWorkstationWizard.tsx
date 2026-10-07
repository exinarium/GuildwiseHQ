import type { InstallerOs, InstallerSession, InstallerStatus, InstallerStep } from '@aom/shared';
import { CircleAlert, CircleCheck, CircleDashed, Download, LifeBuoy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useCreateInstaller, useInstallerStatus } from '../../api/queries/workstations.ts';
import {
  detectOs,
  guideSteps,
  LINUX_FLAVOURS,
  type LinuxFlavour,
  OS_OPTIONS,
  whatItDoes,
} from '../../lib/installer-guide.ts';
import { copyText } from '../../lib/secure.ts';
import {
  Badge,
  Button,
  Callout,
  cx,
  Dialog,
  Disclosure,
  ErrorBox,
  Spinner,
  TextInput,
  useToast,
} from '../ui.tsx';
import { InstallArt } from './InstallArt.tsx';

/**
 * "Add a workstation" (docs/design/open-questions.md, "Runner installer with a guided setup"): pick the system, read
 * the plain-language steps, copy one command (or download the script) and watch the machine pair and report its
 * health checks. The command carries a short-lived link and a one-time pairing code; nothing long-lived.
 */
export function AddWorkstationWizard({
  open,
  onOpenChange,
  onPairWithCode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The "I already have the runner" path: the one-time code dialog. */
  onPairWithCode: () => void;
}) {
  const [os, setOs] = useState<InstallerOs>(() => detectOs(navigator));
  const [flavour, setFlavour] = useState<LinuxFlavour>('ubuntu');
  const [name, setName] = useState('');
  const create = useCreateInstaller();
  const [session, setSession] = useState<InstallerSession | null>(null);
  const status = useInstallerStatus(session?.id);

  // Changing the system, or reopening, starts a new session: a new one-time code and link.
  const made = useRef<string>('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new session only when the system changes or the dialog opens
  useEffect(() => {
    if (!open) return;
    const key = `${os}`;
    if (made.current === key && session) return;
    made.current = key;
    setSession(null);
    create.mutate({ os, ...(name.trim() ? { name: name.trim() } : {}) }, { onSuccess: (s) => setSession(s) });
  }, [open, os]);

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      made.current = '';
      setSession(null);
      create.reset();
    }
  };

  const st = status.data;
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      size="xl"
      title="Add a workstation"
      description="A workstation is a computer of yours that runs your agents. This takes about ten minutes and you do not need to know anything about servers."
    >
      <div className="flex flex-col gap-5" data-testid="add-workstation">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold text-fg">
            1. Which computer will run your agents?
          </legend>
          <div role="radiogroup" aria-label="Operating system" className="grid gap-2 sm:grid-cols-3">
            {OS_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={os === o.value}
                data-testid={`os-${o.value}`}
                onClick={() => setOs(o.value)}
                className={cx(
                  'rounded-card border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none',
                  os === o.value
                    ? 'border-brand bg-brand-soft text-brand-soft-fg'
                    : 'border-control bg-surface text-fg hover:bg-sunken',
                )}
              >
                <span className="block text-base font-semibold">{o.label}</span>
                <span className="block text-sm opacity-80">{o.sub}</span>
              </button>
            ))}
          </div>
          {os === 'linux' && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm" data-testid="linux-flavours">
              {LINUX_FLAVOURS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={flavour === f.value}
                  onClick={() => setFlavour(f.value)}
                  className={cx(
                    'rounded-full border px-3 py-1',
                    flavour === f.value
                      ? 'border-brand bg-brand-soft text-brand-soft-fg'
                      : 'border-control text-muted hover:bg-sunken',
                  )}
                >
                  {f.label}
                </button>
              ))}
              <span className="text-subtle">{LINUX_FLAVOURS.find((f) => f.value === flavour)?.note}</span>
            </div>
          )}
          {os === 'windows' && (
            <p className="text-sm text-muted">
              Windows runs the agents inside <strong>WSL2</strong>, Microsoft's built-in Linux. It keeps them
              safely fenced in. The installer sets it up for you.
            </p>
          )}
        </fieldset>

        <div className="max-w-sm">
          <TextInput
            label="Name for this workstation (optional)"
            id="workstation-name"
            value={name}
            maxLength={80}
            placeholder="Defaults to the computer's name"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              // a new name goes into a new script: ask for a fresh session
              made.current = '';
              if (session)
                create.mutate(
                  { os, ...(name.trim() ? { name: name.trim() } : {}) },
                  { onSuccess: (s) => setSession(s) },
                );
            }}
          />
        </div>

        {create.isPending && !session && <Spinner label="Preparing your install command" />}
        <ErrorBox error={create.error} onRetry={() => create.mutate({ os })} />

        {session && (
          <>
            <section aria-labelledby="install-steps" className="flex flex-col gap-3">
              <h3 id="install-steps" className="text-sm font-semibold text-fg">
                2. Run the installer on that computer
              </h3>
              <ol className="flex flex-col gap-2" data-testid="install-steps">
                {guideSteps(os).map((s, i) => (
                  <li
                    key={s.id}
                    className="flex items-start gap-3 rounded-card border border-line bg-surface p-3"
                  >
                    <InstallArt kind={s.art} />
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-semibold text-fg">
                        <span className="mr-1.5 text-subtle">{i + 1}.</span>
                        {s.title}
                      </p>
                      <p className="mt-0.5 text-sm text-muted">{s.body}</p>
                      {s.command && <CommandBox session={session} />}
                    </div>
                  </li>
                ))}
              </ol>
              <Disclosure summary="What will this change on my computer?" data-testid="what-it-does">
                <ul className="list-disc space-y-1 pl-6 text-sm text-muted">
                  {whatItDoes(os).map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
                <p className="mt-2 text-sm text-muted">
                  You can read the whole script before you run it: use <strong>Download the script</strong>.
                  It contains a one-time pairing code and this server's address, and no password or long-lived
                  key.
                </p>
              </Disclosure>
            </section>

            <section aria-labelledby="install-progress" className="flex flex-col gap-3">
              <h3 id="install-progress" className="text-sm font-semibold text-fg">
                3. Watch it connect
              </h3>
              <Progress session={session} status={st} onClose={() => close(false)} />
            </section>
          </>
        )}

        <p className="border-t border-line pt-3 text-sm text-muted">
          Already have the runner on this computer?{' '}
          <button
            type="button"
            data-testid="pair-with-code"
            className="font-medium text-brand-text underline-offset-2 hover:underline"
            onClick={() => {
              close(false);
              onPairWithCode();
            }}
          >
            Pair it with a code instead
          </button>
          .
        </p>
      </div>
    </Dialog>
  );
}

function CommandBox({ session }: { session: InstallerSession }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const ok = await copyText(session.oneLiner);
    setCopied(ok);
    if (ok) toast.success('Command copied');
  };
  return (
    <div className="mt-2 flex flex-col gap-2">
      <pre
        data-testid="install-command"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard reachable
        tabIndex={0}
        className="overflow-x-auto rounded-control bg-side p-2.5 font-mono text-xs text-side-strong"
      >
        {session.oneLiner}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={copy} data-testid="copy-install-command">
          {copied ? 'Copied' : 'Copy command'}
        </Button>
        <a
          href={session.downloadUrl}
          download={session.fileName}
          data-testid="download-script"
          className="inline-flex h-8 items-center gap-2 rounded-control border border-control bg-surface px-3 text-sm font-medium text-fg hover:bg-sunken [@media(pointer:coarse)]:min-h-11"
        >
          <Download aria-hidden="true" className="size-4" />
          Download the script
        </a>
        <span className="text-xs text-subtle">
          Works for 30 minutes
          {session.release ? ` · runner ${session.release.version}` : ''}
        </span>
      </div>
      {!session.release && (
        <Callout tone="warning" data-testid="no-release">
          This server has no runner download yet, so the installer cannot finish. Ask your platform
          administrator to publish the runner release.
        </Callout>
      )}
    </div>
  );
}

const STAGES = ['started', 'paired', 'checks', 'done'] as const;

/** How many stages are complete for a state (a failed run keeps what it reached). */
function stagesDone(status: InstallerStatus | undefined): number {
  if (!status) return 0;
  switch (status.state) {
    case 'waiting':
    case 'expired':
      return 0;
    case 'running':
      return status.workstationId ? 2 : 1;
    case 'paired':
    case 'checking':
      return 2;
    case 'done':
      return status.result === 'failed' ? (status.workstationId ? 2 : 1) : 4;
  }
}

function Progress({
  session,
  status,
  onClose,
}: {
  session: InstallerSession;
  status: InstallerStatus | undefined;
  onClose: () => void;
}) {
  const state = status?.state ?? 'waiting';
  const complete = stagesDone(status);
  const failed = status?.result === 'failed';
  const lastFail: InstallerStep | undefined = status?.steps.filter((s) => s.status === 'fail').at(-1);
  return (
    <div className="flex flex-col gap-3" data-testid="install-progress" data-state={state}>
      <ol className="flex flex-col gap-1.5" aria-label="Progress">
        {STAGES.map((id, i) => {
          const done = i < complete;
          const current = i === complete && state !== 'expired' && !failed && state !== 'done';
          const label = {
            started:
              complete > 0
                ? 'The installer is running on your computer'
                : 'Waiting for you to run the command',
            paired: status?.workstationName
              ? `Paired as ${status.workstationName}`
              : 'Paired with your account',
            checks: 'Health checks',
            done: 'Ready',
          }[id];
          return (
            <li
              key={id}
              data-testid={`stage-${id}`}
              data-done={done || undefined}
              aria-current={current ? 'step' : undefined}
              className={cx(
                'flex items-center gap-2 text-sm',
                done ? 'text-fg' : current ? 'font-medium text-fg' : 'text-subtle',
              )}
            >
              {done ? (
                <CircleCheck aria-hidden="true" className="size-5 text-success" />
              ) : current ? (
                <Spinner inline label={label} />
              ) : (
                <CircleDashed aria-hidden="true" className="size-5" />
              )}
              <span>{label}</span>
            </li>
          );
        })}
      </ol>

      {status && status.doctor.length > 0 && (
        <ul
          className="grid gap-1 rounded-card border border-line bg-surface p-3 text-sm sm:grid-cols-2"
          data-testid="doctor-checks"
        >
          {status.doctor.map((d) => (
            <li key={d.step} className="flex items-start gap-2" data-testid={`doctor-${d.step}`}>
              <Badge tone={d.status === 'ok' ? 'green' : d.status === 'warn' ? 'amber' : 'red'}>
                {d.status === 'ok' ? 'ok' : d.status === 'warn' ? 'warn' : 'fail'}
              </Badge>
              <span className="min-w-0">
                <span className="font-medium text-fg">{d.step}</span>
                <span className="block break-words text-muted">{d.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {status && status.steps.length > 0 && (
        <Disclosure summary="Installer log" data-testid="install-log">
          <ul className="space-y-0.5 font-mono text-xs text-muted">
            {status.steps.map((s) => (
              <li key={`${s.at}-${s.step}-${s.status}`}>
                [{s.status}] {s.step}
                {s.detail ? `: ${s.detail}` : ''}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}

      {state === 'done' && !failed && (
        <Callout tone="success" role="status" data-testid="install-success">
          <span className="flex flex-wrap items-center gap-3">
            <span>
              {status?.workstationName ?? 'Your computer'} is connected. Hire an agent onto it to start
              working.
            </span>
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          </span>
        </Callout>
      )}
      {(failed || state === 'expired') && (
        <InstallFailure expired={state === 'expired'} reason={lastFail?.detail} onClose={onClose} />
      )}
      {state === 'waiting' && (
        <p className="text-xs text-subtle" data-testid="install-waiting-hint">
          Nothing to do here until you run the command. This page checks every couple of seconds.
        </p>
      )}
      <span className="sr-only">{session.id}</span>
    </div>
  );
}

/** Shown when an install failed or the link ran out: what to do next, with Help and Contact us one click away. */
export function InstallFailure({
  expired,
  reason,
  onClose,
}: {
  expired?: boolean;
  reason?: string | undefined;
  onClose?: () => void;
}) {
  return (
    <Callout
      tone={expired ? 'warning' : 'danger'}
      role="alert"
      data-testid="install-failure"
      title={expired ? 'This command has expired' : 'The installer did not finish'}
    >
      <p>
        {expired
          ? 'For safety the command only works for 30 minutes. Choose your system again (or reopen this window) to get a new one.'
          : `Nothing is broken: run the same command again and it carries on where it stopped.${reason ? ` What it said: ${reason}` : ''}`}
      </p>
      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link
          to="/help/install-troubleshooting"
          onClick={onClose}
          className="inline-flex items-center gap-1 font-medium underline"
          data-testid="install-help"
        >
          <LifeBuoy aria-hidden="true" className="size-4" />
          Read the installer help
        </Link>
        <Link
          to="/help/contact?from=installer"
          onClick={onClose}
          className="inline-flex items-center gap-1 font-medium underline"
          data-testid="install-contact"
        >
          <CircleAlert aria-hidden="true" className="size-4" />
          Contact us
        </Link>
      </p>
    </Callout>
  );
}
