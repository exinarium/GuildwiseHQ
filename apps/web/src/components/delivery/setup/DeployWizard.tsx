import {
  type DeliverySetup,
  hasBlockers,
  type ProbeReport,
  type ProbeRequest,
  planChanges,
  type SetupEnv,
  type SetupProbeDto,
  type SetupStateDto,
  type SetupWorkstationDto,
} from '@aom/shared';
import { ArrowLeft, Check, Monitor, Search, Server, Sparkles, TestTube2 } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  usePreviewSetup,
  useProbe,
  usePublishSetup,
  useSaveSetupDraft,
  useSetupState,
  useStartDeployScan,
} from '../../../api/queries/deploy-setup.ts';
import { useAddDeployTarget, usePatchDeployTarget } from '../../../api/queries/phases.ts';
import { Badge, Button, Callout, cx, ErrorBox, Select, Spinner, TextInput } from '../../ui.tsx';
import { FoundChanges } from './FoundChanges.tsx';
import {
  type Answers,
  answersFromEnv,
  buildEnv,
  CONNECTION_TEXT,
  emptyAnswers,
  guessAppService,
  guessAppUrl,
  guessDbService,
  guessImageName,
  healthProbeUrls,
  healthyUrls,
  imageVarOf,
  type Purpose,
  plainLint,
  type Stack,
  stacksFromReport,
  whenText,
  withEnv,
} from './model.ts';

type StepId = 'kind' | 'where' | 'computer' | 'signin' | 'details' | 'when' | 'review';

const STEP_LABEL: Record<StepId, string> = {
  kind: 'What for',
  where: 'Where',
  computer: 'This computer',
  signin: 'Your server',
  details: 'What we found',
  when: 'When',
  review: 'Review',
};

/** How far the person is, for the "Step 2 of 5" line. */
const stepsFor = (a: Answers, includeKind: boolean): StepId[] => [
  ...(includeKind ? (['kind'] as const) : []),
  'where',
  a.hosting === 'ssh' ? 'signin' : 'computer',
  'details',
  'when',
  'review',
];

function useProbeFlow(projectId: string, probes: SetupProbeDto[]) {
  const probe = useProbe(projectId);
  const [asked, setAsked] = useState<{
    scope: string;
    workstationId: string;
    host: string | null;
    before: string | null;
  } | null>(null);
  const find = (scope: string, workstationId: string, host: string | null) =>
    probes.find((p) => p.scope === scope && p.workstationId === workstationId && (p.host ?? null) === host);
  const ask = (req: ProbeRequest & { workstationId: string }) => {
    const host = req.scope === 'ssh_target' ? (req.host ?? null) : null;
    setAsked({
      scope: req.scope,
      workstationId: req.workstationId,
      host,
      before: find(req.scope, req.workstationId, host)?.id ?? null,
    });
    probe.mutate(req, { onError: () => setAsked(null) });
  };
  const current = asked ? find(asked.scope, asked.workstationId, asked.host) : undefined;
  const fresh = !!asked && !!current && current.id !== asked.before;
  const loading = !!asked && !fresh && !probe.isError;
  return { ask, loading, error: probe.error, result: fresh ? current : undefined, asked };
}

/** A card the person taps; selected ones are ringed. */
function Choice({
  selected,
  onClick,
  icon,
  title,
  children,
  disabled,
  testId,
}: {
  selected?: boolean;
  onClick: () => void;
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      data-testid={testId}
      className={cx(
        'flex min-h-14 w-full items-start gap-3 rounded-control border p-3 text-left transition-colors disabled:opacity-60',
        selected
          ? 'border-brand bg-brand-soft ring-1 ring-brand'
          : 'border-control bg-surface hover:bg-sunken',
      )}
    >
      {icon && <span className="mt-0.5 shrink-0 text-muted">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-fg">{title}</span>
        {children && <span className="mt-0.5 block text-sm text-muted">{children}</span>}
      </span>
      {selected && <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand" />}
    </button>
  );
}

/**
 * The guided deploy wizard for "On this computer" and "On my own server with the sign-in this computer already has"
 * (docs/design/deploy-run-ux-design.md sections 2 J2/J3 and 3.2). One question per screen, a sticky bar at the bottom, plain
 * words; the developer view (technical details) edits the same setup. Nothing is written until the last step, and what
 * is written still needs the Owner's approval of exactly that version.
 */
export function DeployWizard({
  projectId,
  state,
  editing,
  initialPurpose,
  onClose,
  onAdvanced,
}: {
  projectId: string;
  state: SetupStateDto;
  /** An existing environment to change (opens at "What we found"). */
  editing?: SetupEnv | undefined;
  initialPurpose?: Purpose | undefined;
  onClose: () => void;
  onAdvanced: () => void;
}) {
  const live = useSetupState(projectId, true);
  const s = live.data ?? state;
  const currentSetup: DeliverySetup | null =
    s.current.setup ?? (s.draft?.setup as DeliverySetup | null) ?? null;
  const includeKind = !editing;
  const editTarget = editing ? s.targets.find((t) => t.name === editing.target) : undefined;
  const [answers, setAnswers] = useState<Answers>(() =>
    editing
      ? {
          ...answersFromEnv(editing, { production: editTarget?.production ?? false }),
          workstationId: editTarget?.workstationId ?? '',
        }
      : emptyAnswers(
          initialPurpose ?? (currentSetup?.environments.some((e) => e.name === 'uat') ? 'live' : 'test'),
        ),
  );
  const [step, setStep] = useState<StepId>(editing ? 'details' : 'kind');
  const [stack, setStack] = useState<Stack | undefined>();
  const set = (patch: Partial<Answers>) => setAnswers((a) => ({ ...a, ...patch }));
  const usable = s.workstations.filter((w) => w.canProbe);
  const wsId = answers.workstationId || usable.find((w) => w.mine && w.connected)?.id || usable[0]?.id || '';
  const ws = s.workstations.find((w) => w.id === wsId);
  const flow = useProbeFlow(projectId, s.probes);
  const scan = useStartDeployScan(projectId);
  const addTarget = useAddDeployTarget(projectId);
  const patchTarget = usePatchDeployTarget(projectId);
  const preview = usePreviewSetup(projectId);
  const publish = usePublishSetup(projectId);
  const saveDraft = useSaveSetupDraft(projectId);
  const [published, setPublished] = useState<string | null>(null);
  // files of the project's deploy folder that the setup does not make: kept unless the person ticks them
  const [removeFiles, setRemoveFiles] = useState<string[]>([]);
  const steps = stepsFor(answers, includeKind);
  const at = Math.max(0, steps.indexOf(step));

  // the report that applies now: the freshest answer for the chosen computer (local) or server
  const localReport = useMemo<ProbeReport | null>(
    () => s.probes.find((p) => p.scope === 'local' && p.workstationId === wsId && p.report)?.report ?? null,
    [s.probes, wsId],
  );
  const serverReport = useMemo<ProbeReport | null>(
    () =>
      s.probes.find(
        (p) => p.scope === 'ssh_target' && p.workstationId === wsId && p.host === answers.host && p.report,
      )?.report ?? null,
    [s.probes, wsId, answers.host],
  );
  const report = answers.hosting === 'ssh' ? serverReport : localReport;
  const stacks = useMemo(() => stacksFromReport(report), [report]);
  const hostsProbe = s.probes.find((p) => p.scope === 'ssh_hosts' && p.workstationId === wsId);
  const homeDir = useMemo(() => {
    // `~` in a stored path needs the home the probe saw: its backups/compose paths start with it
    const p = localReport?.composeFiles[0]?.path ?? '';
    const m = /^(\/home\/[^/]+|\/Users\/[^/]+|\/root)\//.exec(p);
    return m?.[1];
  }, [localReport]);

  // choosing a computer starts the look at Docker; choosing a server starts the look at it
  const askedFor = useRef('');
  useEffect(() => {
    if (!wsId) return;
    const key = step === 'computer' ? `local:${wsId}` : step === 'signin' ? `hosts:${wsId}` : '';
    if (!key || askedFor.current === key) return;
    askedFor.current = key;
    if (step === 'computer')
      flow.ask({
        scope: 'local',
        workstationId: wsId,
        hints: { composeFiles: editing ? [editing.app.composeFile] : [] },
      });
    else flow.ask({ scope: 'ssh_hosts', workstationId: wsId });
  }, [step, wsId, editing, flow.ask]);

  // a server just looked at: the sites it answers on are asked about, once, so the health check can be offered
  const followUp = useRef('');
  useEffect(() => {
    const r = flow.result;
    const key = `${wsId}:${answers.host}`;
    if (!r || r.scope !== 'ssh_target' || !r.report || followUp.current === key) return;
    followUp.current = key;
    const urls = healthProbeUrls(r.report);
    const dirs = [...new Set(r.report.composeFiles.map((c) => c.path.slice(0, c.path.lastIndexOf('/'))))];
    if (urls.length)
      flow.ask({ scope: 'ssh_target', workstationId: wsId, host: answers.host, hints: { urls, dirs } });
  }, [flow.result, flow.ask, wsId, answers.host]);

  const pickStack = (st: Stack, rpt: ProbeReport | null) => {
    const app = guessAppService(st);
    const iv = imageVarOf(rpt, st);
    const image = answers.hosting === 'ssh' && iv.value ? iv.value.split(':')[0] : '';
    const healthy = healthyUrls(rpt);
    setStack(st);
    set({
      stackPath: st.path,
      composeProject: st.project && /^[a-z0-9][a-z0-9_-]*$/.test(st.project) ? st.project : '',
      appService: app,
      dbService: guessDbService(st),
      imageName: guessImageName(st, app, image || undefined),
      appUrl: answers.hosting === 'ssh' ? '' : guessAppUrl(st, app),
      imageVar: iv.name,
      backupDir: st.path.slice(0, st.path.lastIndexOf('/'))
        ? `${st.path.slice(0, st.path.lastIndexOf('/'))}/backups`
        : '',
      healthUrl:
        healthy[0] ??
        (answers.hosting === 'ssh'
          ? ''
          : `${guessAppUrl(st, app)}/api/health`.replace(/^\/api\/health$/, '')),
    });
    setStep('details');
  };

  const chosenStack = stack ?? stacks.find((x) => x.path === answers.stackPath);
  const env = useMemo(
    () =>
      buildEnv(
        {
          ...answers,
          workstationId: wsId,
          testEnv:
            answers.purpose === 'live'
              ? (currentSetup?.environments.find((e) => e.name !== answers.name && e.name === 'uat')?.name ??
                null)
              : null,
        },
        homeDir,
      ),
    [answers, wsId, currentSetup, homeDir],
  );
  const proposed = useMemo(() => withEnv(currentSetup, env), [currentSetup, env]);
  const changes = useMemo(
    () => planChanges({ version: 1, generator: s.generator, environments: [env] }, { [env.name]: report }),
    [env, report, s.generator],
  );

  const ensureTarget = async (): Promise<boolean> => {
    const existing = s.targets.find((t) => t.name.toLowerCase() === answers.targetName.toLowerCase());
    try {
      if (existing) {
        await patchTarget.mutateAsync({
          id: existing.id,
          body: {
            production: answers.production,
            ...(existing.kind === 'remote_ssh' ? {} : { workstationId: wsId || null }),
            ...(answers.appUrl ? { appUrl: answers.appUrl } : {}),
          },
        });
      } else {
        await addTarget.mutateAsync({
          name: answers.targetName,
          kind: answers.hosting === 'ssh' ? 'remote_ssh' : 'local_docker',
          workstationId: wsId || null,
          ...(answers.hosting === 'ssh' ? { host: answers.host } : {}),
          ...(answers.appUrl || (answers.hosting === 'ssh' && answers.healthUrl)
            ? { appUrl: answers.appUrl || new URL(answers.healthUrl).origin }
            : {}),
          notes: '',
          production: answers.production,
        });
      }
      return true;
    } catch {
      return false;
    }
  };

  const goReview = async () => {
    if (!(await ensureTarget())) return;
    setStep('review');
    preview.mutate({ setup: proposed, removeFiles });
    saveDraft.mutate({ setup: proposed });
  };

  const save = () => {
    if (!preview.data?.hash) return;
    publish.mutate(
      { setup: proposed, setupHash: preview.data.hash, removeFiles },
      { onSuccess: (r) => setPublished(r.commandId) },
    );
  };
  const pub = s.publish;
  const written = !!published && pub?.commandId === published && pub.status === 'written';
  const failed = !!published && pub?.commandId === published && pub.status === 'failed';

  // ---------------------------------------------------------------------------------------------- the steps
  const back = () => {
    const i = steps.indexOf(step);
    if (i <= 0) onClose();
    else setStep(steps[i - 1] as StepId);
  };
  const next = () => setStep(steps[Math.min(steps.length - 1, steps.indexOf(step) + 1)] as StepId);

  const blockers = hasBlockers(changes);
  const canNext: Record<StepId, boolean> = {
    kind: true,
    where: true,
    computer: !!chosenStack,
    signin: !!chosenStack,
    details:
      !!answers.appService &&
      !!answers.imageName &&
      (answers.hosting !== 'ssh' || !!answers.imageVar) &&
      !blockers,
    when: true,
    review: false,
  };

  return (
    <div className="flex flex-col gap-4" data-testid="deploy-wizard">
      <div>
        <button
          type="button"
          onClick={back}
          className="mb-1 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
          data-testid="wizard-back-top"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {step === steps[0] ? 'Cancel' : 'Back'}
        </button>
        <p className="text-xs text-subtle" data-testid="wizard-step">
          Step {at + 1} of {steps.length}: {STEP_LABEL[step]}
        </p>
        <div className="mt-1 flex gap-1" aria-hidden="true">
          {steps.map((x, i) => (
            <span key={x} className={cx('h-1 flex-1 rounded-full', i <= at ? 'bg-brand' : 'bg-line')} />
          ))}
        </div>
      </div>

      {step === 'kind' && (
        <section className="flex flex-col gap-3">
          <h3 className="text-lg font-semibold text-fg">What is this copy of your app for?</h3>
          <Choice
            selected={answers.purpose === 'test'}
            onClick={() => setAnswers(emptyAnswers('test'))}
            icon={<TestTube2 aria-hidden="true" className="size-5" />}
            title="Testing before going live"
            testId="kind-test"
          >
            A test copy. It updates by itself after changes are merged, so you can try things out.
          </Choice>
          <Choice
            selected={answers.purpose === 'live'}
            onClick={() => setAnswers(emptyAnswers('live'))}
            icon={<Sparkles aria-hidden="true" className="size-5" />}
            title="The live site (production)"
            testId="kind-live"
          >
            The one your customers use. It only updates when you press Release, and only after the test copy
            is healthy.
          </Choice>
        </section>
      )}

      {step === 'where' && (
        <section className="flex flex-col gap-3">
          <h3 className="text-lg font-semibold text-fg">
            Where should the {answers.label.toLowerCase()} run?
          </h3>
          <Choice
            selected={answers.hosting === 'this_computer'}
            onClick={() => set({ hosting: 'this_computer' })}
            icon={<Monitor aria-hidden="true" className="size-5" />}
            title="On this computer"
            testId="where-computer"
          >
            A computer where Guildwise runs, with Docker (an office PC or a server in your office).
          </Choice>
          <Choice
            selected={answers.hosting === 'ssh'}
            onClick={() => set({ hosting: 'ssh' })}
            icon={<Server aria-hidden="true" className="size-5" />}
            title="On my own server (VPS)"
            testId="where-server"
          >
            A server you rent. Guildwise uses the sign-in your computer already has.
          </Choice>
          <Choice
            onClick={() => scan.mutate({}, { onSuccess: onClose })}
            icon={<Search aria-hidden="true" className="size-5" />}
            title="Not sure: let DevOps look"
            testId="where-scan"
          >
            DevOps reads the project and what is already running, and suggests the setup. You review it.
          </Choice>
          <ErrorBox error={scan.error} />
          <p className="text-xs text-subtle">
            Hosting platforms like Render or Fly are not supported yet.{' '}
            <button type="button" className="underline" onClick={onAdvanced}>
              Show technical details
            </button>
          </p>
        </section>
      )}

      {(step === 'computer' || step === 'signin') && (
        <section className="flex flex-col gap-3">
          <h3 className="text-lg font-semibold text-fg">
            {step === 'computer'
              ? 'Which computer should do the updates?'
              : 'How do you sign in to your server?'}
          </h3>
          {usable.length === 0 ? (
            <Callout tone="warning" title="No computer can do this yet" data-testid="no-capable-computer">
              {s.workstations.find((w) => w.blocked)?.blocked ??
                'Connect Guildwise on a computer of this project first.'}{' '}
              The developer view still works.
            </Callout>
          ) : (
            <>
              {usable.length > 1 && (
                <Select
                  label="The computer that updates it"
                  value={wsId}
                  onChange={(e) => {
                    set({ workstationId: e.target.value });
                    setStack(undefined);
                  }}
                  data-testid="wizard-computer"
                >
                  {usable.map((w: SetupWorkstationDto) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                      {w.connected ? '' : ' (offline)'}
                    </option>
                  ))}
                </Select>
              )}
              {usable.length === 1 && (
                <p className="text-sm text-muted">
                  The updates run on <strong>{ws?.name}</strong>.
                </p>
              )}
            </>
          )}
          {flow.loading && (
            <div
              className="flex items-center gap-2 text-sm text-muted"
              role="status"
              data-testid="probe-waiting"
            >
              <Spinner inline label="Looking" />
              {step === 'computer'
                ? `Looking at Docker on ${ws?.name ?? 'the computer'}...`
                : `Looking at the servers ${ws?.name ?? 'the computer'} can reach...`}
            </div>
          )}
          <ErrorBox error={flow.error} />
          {step === 'computer' && (
            <ComputerChoices
              flow={flow}
              stacks={stacks}
              report={localReport}
              chosen={chosenStack}
              onPick={(st) => pickStack(st, localReport)}
              onAgain={() => {
                askedFor.current = '';
                flow.ask({ scope: 'local', workstationId: wsId });
              }}
              onScan={() => scan.mutate({}, { onSuccess: onClose })}
            />
          )}
          {step === 'signin' && (
            <ServerChoices
              hosts={hostsProbe}
              loadingHosts={flow.loading && flow.asked?.scope === 'ssh_hosts'}
              host={answers.host}
              onHost={(h) => {
                set({ host: h, targetName: s.targets.find((t) => t.host === h)?.name ?? answers.targetName });
                flow.ask({ scope: 'ssh_target', workstationId: wsId, host: h });
              }}
              serverLoading={flow.loading && flow.asked?.scope === 'ssh_target'}
              serverResult={s.probes.find(
                (p) => p.scope === 'ssh_target' && p.workstationId === wsId && p.host === answers.host,
              )}
              stacks={stacks}
              chosen={chosenStack}
              onPick={(st) => pickStack(st, serverReport)}
              onAgain={() => {
                askedFor.current = '';
                flow.ask({ scope: 'ssh_hosts', workstationId: wsId });
              }}
            />
          )}
        </section>
      )}

      {step === 'details' && (
        <Details
          answers={answers}
          set={set}
          stack={chosenStack}
          report={report}
          changes={changes}
          onCheckUrl={(url) =>
            flow.ask({
              scope: answers.hosting === 'ssh' ? 'ssh_target' : 'local',
              workstationId: wsId,
              ...(answers.hosting === 'ssh' ? { host: answers.host } : {}),
              hints: { urls: [url] },
            })
          }
          checking={flow.loading}
        />
      )}

      {step === 'when' && (
        <When
          answers={answers}
          set={set}
          testEnvExists={!!currentSetup?.environments.some((e) => e.name === 'uat')}
        />
      )}

      {step === 'review' && (
        <Review
          answers={answers}
          preview={preview.data}
          previewing={preview.isPending}
          previewError={preview.error}
          changes={changes}
          publishError={publish.error}
          saving={publish.isPending || (!!published && !written && !failed)}
          written={written}
          failed={failed ? (pub?.error ?? 'The computer could not save the files.') : null}
          onSave={save}
          removeFiles={removeFiles}
          onToggleRemove={(path) => {
            const next = removeFiles.includes(path)
              ? removeFiles.filter((x) => x !== path)
              : [...removeFiles, path];
            setRemoveFiles(next);
            preview.mutate({ setup: proposed, removeFiles: next });
          }}
          onAgain={() => preview.mutate({ setup: proposed, removeFiles })}
          onDone={onClose}
          onAdvanced={onAdvanced}
        />
      )}

      {/* the sticky bar (mobile: always in reach of the thumb) */}
      {step !== 'review' && (
        <div
          className="sticky bottom-[var(--app-bottom-inset,0px)] z-10 -mx-4 flex gap-2 border-t border-line bg-surface px-4 py-3 sm:mx-0 sm:rounded-control sm:border"
          data-testid="wizard-bar"
        >
          <Button onClick={back}>{step === steps[0] ? 'Cancel' : 'Back'}</Button>
          <Button
            variant="primary"
            className="flex-1 sm:flex-none"
            disabled={!canNext[step] || addTarget.isPending || patchTarget.isPending}
            loading={addTarget.isPending || patchTarget.isPending}
            onClick={step === 'when' ? () => void goReview() : next}
            data-testid="wizard-next"
          >
            {step === 'when' ? 'Review' : 'Continue'}
          </Button>
        </div>
      )}
      {(addTarget.error || patchTarget.error) && <ErrorBox error={addTarget.error ?? patchTarget.error} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ this computer

function ComputerChoices({
  flow,
  stacks,
  report,
  chosen,
  onPick,
  onAgain,
  onScan,
}: {
  flow: ReturnType<typeof useProbeFlow>;
  stacks: Stack[];
  report: ProbeReport | null;
  chosen: Stack | undefined;
  onPick: (s: Stack) => void;
  onAgain: () => void;
  onScan: () => void;
}) {
  const r = flow.result;
  if (flow.loading || !r) return null;
  if (r.error)
    return (
      <Callout
        tone="warning"
        title="Could not look at Docker"
        data-testid="probe-error"
        actions={
          <Button size="sm" onClick={onAgain}>
            Check again
          </Button>
        }
      >
        {r.errorText}
      </Callout>
    );
  if (stacks.length === 0)
    return (
      <Callout
        tone="info"
        title="Nothing is running with Docker Compose here"
        data-testid="no-stacks"
        actions={
          <Button size="sm" onClick={onAgain}>
            Check again
          </Button>
        }
      >
        <p>
          Docker is {report?.docker?.usable ? 'ready' : 'not ready'} on this computer, but Guildwise found no
          app to update. Starting a new copy from scratch comes in a later version.
        </p>
        <p className="mt-1">
          <button type="button" className="underline" onClick={onScan}>
            Let DevOps look at the project
          </button>{' '}
          or use the developer view.
        </p>
      </Callout>
    );
  return (
    <div className="flex flex-col gap-2" data-testid="stacks">
      <p className="text-sm text-muted">
        Found on this computer. Guildwise will use one of these and keep everything else as it is.
      </p>
      {stacks.map((st) => (
        <Choice
          key={st.path}
          selected={chosen?.path === st.path}
          onClick={() => onPick(st)}
          title={st.project ?? st.path.split('/').slice(-2, -1)[0] ?? 'App'}
          testId="stack-choice"
        >
          {st.services.length} {st.services.length === 1 ? 'part' : 'parts'} (
          {st.services.map((x) => x.name).join(', ')}).{' '}
          {st.running
            ? `Running now (${st.containers.filter((c) => c.state === 'running').length} of ${st.containers.length}).`
            : 'Not running.'}
          <span className="mt-0.5 block font-mono text-xs text-subtle [overflow-wrap:anywhere]">
            {st.path}
          </span>
        </Choice>
      ))}
      <div>
        <Button size="sm" variant="ghost" onClick={onAgain}>
          Check again
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ a server

function ServerChoices({
  hosts,
  loadingHosts,
  host,
  onHost,
  serverLoading,
  serverResult,
  stacks,
  chosen,
  onPick,
  onAgain,
}: {
  hosts: SetupProbeDto | undefined;
  loadingHosts: boolean;
  host: string;
  onHost: (h: string) => void;
  serverLoading: boolean;
  serverResult: SetupProbeDto | undefined;
  stacks: Stack[];
  chosen: Stack | undefined;
  onPick: (s: Stack) => void;
  onAgain: () => void;
}) {
  const list = hosts?.report?.sshHosts ?? [];
  return (
    <div className="flex flex-col gap-3">
      {hosts?.error && (
        <Callout tone="warning" title="Could not list the servers" data-testid="probe-error">
          {hosts.errorText}
        </Callout>
      )}
      {!loadingHosts && hosts?.report && list.length === 0 && (
        <Callout tone="info" title="This computer does not know any server yet" data-testid="no-hosts">
          Servers show up here when this computer already has a sign-in for them (an entry in its ssh
          settings). Setting up a new sign-in comes in a later version; the developer view can still describe
          a server by hand.
        </Callout>
      )}
      {list.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="ssh-hosts">
          <p className="text-sm text-muted">
            Servers this computer already knows. <strong>Use the sign-in this computer already has</strong>:
          </p>
          {list.map((h) => {
            const c = CONNECTION_TEXT[h.state];
            const ok = h.state === 'reachable';
            return (
              <Choice
                key={h.alias}
                selected={host === h.alias}
                disabled={!ok}
                onClick={() => onHost(h.alias)}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {h.alias}
                    <Badge tone={c.tone}>{c.text}</Badge>
                  </span>
                }
                testId={`host-${h.alias}`}
              >
                {h.hostname ? `${h.hostname}` : ''}
                {h.user ? `, user ${h.user}` : ''}
                {!ok && h.detail ? ` ${h.detail}.` : ''}
                {h.state === 'host_key_changed' && (
                  <span className="mt-1 block text-danger">
                    The server's identity changed. This can mean it was reinstalled, or someone is in between.
                    Guildwise will not connect.
                  </span>
                )}
              </Choice>
            );
          })}
        </div>
      )}
      {serverLoading && (
        <div className="flex items-center gap-2 text-sm text-muted" role="status" data-testid="probe-waiting">
          <Spinner inline label="Looking" />
          Looking at {host} (nothing is changed)...
        </div>
      )}
      {serverResult?.error && !serverLoading && host && (
        <Callout tone="warning" title="Could not look at the server" data-testid="server-error">
          {serverResult.errorText}
        </Callout>
      )}
      {!serverLoading && serverResult?.report && host && stacks.length === 0 && (
        <Callout tone="info" title="No app found on the server" data-testid="no-stacks">
          Guildwise looked in /opt and /srv and found no docker-compose file. Setting up a bare server
          (Docker, folders, HTTPS) comes in a later version.
        </Callout>
      )}
      {!serverLoading && stacks.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="stacks">
          <p className="text-sm text-muted">
            Found on {host}. Guildwise will use one of these and keep everything else as it is.
          </p>
          {stacks.map((st) => (
            <Choice
              key={st.path}
              selected={chosen?.path === st.path}
              onClick={() => onPick(st)}
              title={st.project ?? st.path}
              testId="stack-choice"
            >
              {st.services.length} parts ({st.services.map((x) => x.name).join(', ')}).{' '}
              {st.running ? 'Running now.' : 'Not running.'}
              <span className="mt-0.5 block font-mono text-xs text-subtle [overflow-wrap:anywhere]">
                {st.path}
              </span>
            </Choice>
          ))}
        </div>
      )}
      <div>
        <Button size="sm" variant="ghost" onClick={onAgain}>
          Check again
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ what we found

function Details({
  answers,
  set,
  stack,
  report,
  changes,
  onCheckUrl,
  checking,
}: {
  answers: Answers;
  set: (p: Partial<Answers>) => void;
  stack: Stack | undefined;
  report: ProbeReport | null;
  changes: ReturnType<typeof planChanges>;
  onCheckUrl: (url: string) => void;
  checking: boolean;
}) {
  const parts = stack?.services ?? [];
  const urls = (report?.urls ?? []).filter((u) => u.status !== null);
  const imageVars =
    report?.folders.flatMap((f) => (f.envKeys ?? []).filter((k) => /IMAGE|TAG|VERSION/.test(k))) ?? [];
  const status = report?.urls.find((u) => u.url === answers.healthUrl)?.status;
  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-lg font-semibold text-fg">What we found</h3>
      <FoundChanges items={changes} />
      <div className="flex flex-col gap-3 rounded-control border border-line p-3">
        <Select
          label="Which part is your app?"
          value={answers.appService}
          onChange={(e) => set({ appService: e.target.value })}
          data-testid="details-app"
        >
          {parts.length === 0 && <option value={answers.appService}>{answers.appService || 'Choose'}</option>}
          {parts.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
              {p.build ? ' (built from your code)' : p.image ? ` (${p.image})` : ''}
            </option>
          ))}
        </Select>
        <Select
          label="Which part is the database? (it gets a backup before every update)"
          value={answers.dbService}
          onChange={(e) => set({ dbService: e.target.value })}
          data-testid="details-db"
        >
          <option value="">None: no backup</option>
          {parts.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
              {p.database ? ` (${p.database})` : ''}
            </option>
          ))}
        </Select>
        {answers.hosting === 'ssh' && (
          <Select
            label="Which setting holds the app version on the server?"
            value={answers.imageVar}
            onChange={(e) => set({ imageVar: e.target.value })}
            data-testid="details-imagevar"
          >
            {imageVars.length === 0 && (
              <option value={answers.imageVar}>{answers.imageVar || 'Choose'}</option>
            )}
            {[...new Set([answers.imageVar, ...imageVars].filter(Boolean))].map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        )}
        <div>
          <TextInput
            label="Address Guildwise checks after an update"
            value={answers.healthUrl}
            placeholder="https://your-site.example.com/ready"
            hint={
              status
                ? `This address answered ${status} when we looked.`
                : 'If it does not answer after an update, the previous version is put back. Leave empty for no check.'
            }
            onChange={(e) => set({ healthUrl: e.target.value.trim() })}
            data-testid="details-health"
          />
          <div className="mt-1 flex flex-wrap gap-2">
            {urls.slice(0, 4).map((u) => (
              <button
                key={u.url}
                type="button"
                className="text-xs underline"
                onClick={() => set({ healthUrl: u.url })}
              >
                {u.url} ({u.status})
              </button>
            ))}
            {/^https?:\/\//.test(answers.healthUrl) && (
              <Button
                size="sm"
                variant="ghost"
                loading={checking}
                onClick={() => onCheckUrl(answers.healthUrl)}
              >
                Check this address
              </Button>
            )}
          </div>
        </div>
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 size-4"
            checked={answers.production}
            onChange={(e) => set({ production: e.target.checked })}
            data-testid="details-production"
          />
          <span>
            <strong>This is the live site your customers use (production).</strong>
            <span className="block text-muted">
              Production is never used for tests, and every release needs your approval.
            </span>
          </span>
        </label>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ when

function When({
  answers,
  set,
  testEnvExists,
}: {
  answers: Answers;
  set: (p: Partial<Answers>) => void;
  testEnvExists: boolean;
}) {
  const live = answers.purpose === 'live';
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-lg font-semibold text-fg">When should it update?</h3>
      {!live && (
        <>
          <Choice
            selected={answers.trigger === 'after_merge'}
            onClick={() => set({ trigger: 'after_merge' })}
            title="Automatically after changes are merged"
            testId="when-auto"
          >
            It waits 2 minutes, so a few merges become one update.
          </Choice>
          <Choice
            selected={answers.trigger === 'on_request'}
            onClick={() => set({ trigger: 'on_request' })}
            title="Only when I press Release"
            testId="when-manual"
          >
            Nothing changes until you decide.
          </Choice>
        </>
      )}
      {live && (
        <>
          <Callout tone="info" title="Only when you press Release">
            The live site never updates by itself.
          </Callout>
          <label className="flex min-h-11 items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 size-4"
              checked={answers.requireTestFirst}
              disabled={!testEnvExists}
              onChange={(e) => set({ requireTestFirst: e.target.checked })}
              data-testid="when-test-first"
            />
            <span>
              <strong>Only after the test copy is healthy on the same version</strong>
              <span className="block text-muted">
                For 10 minutes. {testEnvExists ? '' : 'Set up the test copy first to use this.'}
              </span>
            </span>
          </label>
          <label className="flex min-h-11 items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 size-4" checked disabled />
            <span>
              <strong>I approve each release</strong>
              <span className="block text-muted">
                Always on for the live site. Changing it is in the developer view.
              </span>
            </span>
          </label>
        </>
      )}
      <p className="text-xs text-subtle">{whenText(answers.trigger)}.</p>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ review

function Review({
  answers,
  preview,
  previewing,
  previewError,
  changes,
  publishError,
  saving,
  written,
  failed,
  onSave,
  onAgain,
  onDone,
  onAdvanced,
  removeFiles,
  onToggleRemove,
}: {
  answers: Answers;
  preview: ReturnType<typeof usePreviewSetup>['data'];
  previewing: boolean;
  previewError: unknown;
  changes: ReturnType<typeof planChanges>;
  publishError: unknown;
  saving: boolean;
  written: boolean;
  failed: string | null;
  onSave: () => void;
  onAgain: () => void;
  onDone: () => void;
  onAdvanced: () => void;
  removeFiles: string[];
  onToggleRemove: (path: string) => void;
}) {
  const errors = preview?.lint.filter((l) => l.level === 'error') ?? [];
  const warnings = preview?.lint.filter((l) => l.level === 'warn') ?? [];
  const blocked = hasBlockers(preview?.changes?.length ? (preview.changes as never) : changes);
  return (
    <section className="flex flex-col gap-4" data-testid="wizard-review">
      <h3 className="text-lg font-semibold text-fg">Review: {answers.label}</h3>
      {previewing && (
        <div className="flex items-center gap-2 text-sm text-muted" role="status">
          <Spinner inline label="Preparing" />
          Preparing the steps...
        </div>
      )}
      <ErrorBox error={previewError} />
      {preview && !preview.ok && (
        <Callout tone="danger" title="These steps cannot be saved yet" data-testid="review-issues">
          <ul className="list-disc pl-4">
            {preview.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </Callout>
      )}
      {preview?.ok && (
        <>
          <p className="text-sm text-muted">
            {answers.hosting === 'ssh'
              ? `Each update backs up the database, copies a new version to ${answers.host}, switches only the app, checks the site and goes back if it is not healthy.`
              : 'Each update backs up the database, rebuilds only the app from the approved version, checks it and goes back if it is not healthy.'}{' '}
            {whenText(answers.trigger)}.
          </p>
          <FoundChanges items={preview.changes.filter((c) => c.env === answers.name)} />
          {(preview.unmodelled?.length ?? 0) > 0 && (
            <div className="rounded-control border border-line p-3 text-sm" data-testid="review-unmodelled">
              <p className="font-medium text-fg">Other files in the project's deploy folder</p>
              <p className="mt-0.5 text-muted">
                Guildwise does not make these. They stay exactly as they are, unless you tick one to delete
                it.
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {preview.unmodelled?.map((f) => (
                  <li key={f}>
                    <label className="flex min-h-11 items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={removeFiles.includes(f)}
                        onChange={() => onToggleRemove(f)}
                      />
                      <span className="font-mono text-xs [overflow-wrap:anywhere]">{f}</span>
                      <span className="text-xs text-subtle">
                        {removeFiles.includes(f) ? 'will be deleted' : 'kept'}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {errors.length > 0 && (
            <Callout tone="danger" title="Fix this first" data-testid="review-lint-errors">
              <ul className="list-disc pl-4">
                {errors.map((l) => (
                  <li key={l.message}>{plainLint(l)}</li>
                ))}
              </ul>
            </Callout>
          )}
          {warnings.length > 0 && (
            <Callout tone="warning" title="Good to know">
              <ul className="list-disc pl-4">
                {warnings.map((l) => (
                  <li key={l.message}>{plainLint(l)}</li>
                ))}
              </ul>
            </Callout>
          )}
        </>
      )}
      {written ? (
        <Callout tone="success" title="Saved" data-testid="review-saved">
          The steps are in the project's files. Next: <strong>Try it without changing anything</strong>, then
          the Owner approves this version. Nothing runs before that.
        </Callout>
      ) : (
        <>
          {failed && (
            <Callout tone="danger" title="The computer could not save it" data-testid="review-failed">
              {failed}
            </Callout>
          )}
          <ErrorBox error={publishError} />
        </>
      )}
      <div className="sticky bottom-[var(--app-bottom-inset,0px)] z-10 -mx-4 flex flex-wrap gap-2 border-t border-line bg-surface px-4 py-3 sm:mx-0">
        {written ? (
          <Button
            variant="primary"
            className="flex-1 sm:flex-none"
            onClick={onDone}
            data-testid="review-done"
          >
            Done
          </Button>
        ) : (
          <>
            <Button
              variant="primary"
              className="flex-1 sm:flex-none"
              onClick={onSave}
              loading={saving}
              disabled={!preview?.ok || errors.length > 0 || blocked || saving}
              data-testid="review-save"
            >
              Save
            </Button>
            <Button onClick={onAgain}>Preview again</Button>
            <Button variant="ghost" onClick={onAdvanced}>
              Show technical details
            </Button>
          </>
        )}
      </div>
      {!written && (
        <p className="text-xs text-subtle">
          Saving writes the steps into the project files. The Owner still approves the exact version before
          anything runs.
        </p>
      )}
    </section>
  );
}
