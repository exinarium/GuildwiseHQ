// biome-ignore-all lint/correctness/useExhaustiveDependencies: the effects follow the chosen place, they are not re-run by every callback
import {
  type DeliverySetup,
  type ProbeReport,
  planChanges,
  type SetupEnv,
  type SetupStateDto,
} from '@aom/shared';
import { Monitor, Plus, Server, Sparkles, TestTube2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  usePreviewSetup,
  usePublishSetup,
  useSaveSetupDraft,
  useSetupState,
  useStartDeployScan,
} from '../../api/queries/deploy-setup.ts';
import {
  useAddDeployTarget,
  useDeployTargets,
  usePatchDeployTarget,
  useProjectWorkstations,
} from '../../api/queries/phases.ts';
import { PrepareServer } from '../delivery/connect/PrepareServer.tsx';
import { ReachabilityChip } from '../delivery/connect/ReachabilityChip.tsx';
import { TargetTesting } from '../runs/TargetTesting.tsx';
import { Button, Callout, Dialog, Disclosure, ErrorBox, TextInput } from '../ui.tsx';
import { AddServerDialog } from './AddPlaceDialogs.tsx';
import {
  type Answers,
  answersFromEnv,
  buildEnv,
  emptyAnswers,
  guessAppService,
  guessAppUrl,
  guessDbService,
  guessImageName,
  healthProbeUrls,
  healthyUrls,
  imageVarOf,
  type NativeAnswers,
  nativeChangeItems,
  nativeFromApp,
  type Stack,
  stacksFromReport,
  whenText,
  withEnv,
} from './answers.ts';
import { Choice } from './Choice.tsx';
import { DockerDetails, NativeDetails } from './EnvDetails.tsx';
import { EnvReview } from './EnvReview.tsx';
import { FoundApps, type StartChoice } from './FoundApps.tsx';
import { allEnvironments, type EnvRole, METHOD_TEXT, type PlaceVm, placesOf, roleOf } from './model.ts';
import { useProbeFlow } from './useProbeFlow.ts';

type StepId = 'form' | 'details' | 'review';

/** A computer of the project that is not a place yet: it becomes one when the environment is saved. */
interface VirtualPlace {
  id: string;
  workstationId: string;
  name: string;
}

const ROLE_COPY: Record<EnvRole, { title: string; text: string }> = {
  test: {
    title: 'Test site',
    text: 'An always-on copy for people to try. It updates by itself after each merge.',
  },
  live: {
    title: 'Live site',
    text: 'The real thing customers use. It goes out only when you release it, after the test site is healthy.',
  },
  other: {
    title: 'Something else',
    text: 'Another named copy: a demo, a second live site, a customer’s own.',
  },
};

/**
 * Add an environment, or change one (docs/design/environments-ux.md section 5.2): what it is for, where it runs, how it is
 * started, when it updates, then what was found and the review. Nothing is created before Save: a computer that is not a
 * place yet becomes one at that moment, and a place is only ever listed once.
 */
export function EnvironmentDialog({
  projectId,
  state,
  editing,
  initialRole,
  initialPlaceId,
  onClose,
  onAdvanced,
}: {
  projectId: string;
  state: SetupStateDto;
  editing?: SetupEnv | undefined;
  initialRole?: EnvRole | undefined;
  /** Start with this place chosen (a server just added). */
  initialPlaceId?: string | undefined;
  onClose: () => void;
  onAdvanced: () => void;
}) {
  const live = useSetupState(projectId, true);
  const s = live.data ?? state;
  const baseSetup: DeliverySetup | null = (s.draft?.setup as DeliverySetup | null) ?? s.current.setup ?? null;
  const taken = (baseSetup?.environments ?? []).map((e) => e.name);
  const places = useMemo(() => placesOf(s), [s]);
  const active = places.filter((p) => p.role === 'active' && !p.duplicateOf);
  const usable = s.workstations.filter((w) => w.canProbe);
  const virtual: VirtualPlace[] = usable
    .filter((w) => !places.some((p) => p.kind === 'computer' && p.workstationId === w.id))
    .map((w) => ({ id: `ws:${w.id}`, workstationId: w.id, name: w.name }));
  const editTarget = editing ? places.find((p) => p.key === editing.target) : undefined;

  const [answers, setAnswers] = useState<Answers>(() =>
    editing
      ? {
          ...answersFromEnv(editing, { production: editTarget?.production ?? false }),
          workstationId: editTarget?.workstationId ?? '',
          targetName: editing.target,
        }
      : emptyAnswers(initialRole ?? (taken.length === 0 ? 'test' : 'live'), undefined, taken),
  );
  const set = (patch: Partial<Answers>) => setAnswers((a) => ({ ...a, ...patch }));
  const setNative = (patch: Partial<NativeAnswers>) =>
    setAnswers((a) => ({ ...a, native: { ...a.native, ...patch } }));
  const [placeId, setPlaceId] = useState<string>(editTarget?.id ?? initialPlaceId ?? '');
  const [step, setStep] = useState<StepId>('form');
  const [choice, setChoice] = useState<StartChoice | null>(
    editing
      ? editing.app.composeFile && !answers.native.name
        ? { kind: 'stack', path: editing.app.composeFile }
        : { kind: 'typed' }
      : null,
  );
  const [stack, setStack] = useState<Stack | undefined>();
  const [addingServer, setAddingServer] = useState(false);
  const [removeFiles, setRemoveFiles] = useState<string[]>([]);
  const [published, setPublished] = useState<string | null>(null);
  const [folder, setFolder] = useState('');

  const place: PlaceVm | undefined = places.find((p) => p.id === placeId);
  const vplace = virtual.find((v) => v.id === placeId);
  const hosting: Answers['hosting'] = place
    ? place.kind === 'server'
      ? 'ssh'
      : 'this_computer'
    : vplace
      ? 'this_computer'
      : answers.hosting;
  const wsId =
    place?.workstationId ??
    vplace?.workstationId ??
    (answers.workstationId || usable.find((w) => w.mine && w.connected)?.id || usable[0]?.id || '');
  const ws = s.workstations.find((w) => w.id === wsId);
  const placeName = place?.name ?? vplace?.name ?? 'the place';
  const server = hosting === 'ssh';

  const flow = useProbeFlow(projectId, s.probes);
  const scan = useStartDeployScan(projectId);
  const addTarget = useAddDeployTarget(projectId);
  const patchTarget = usePatchDeployTarget(projectId);
  const preview = usePreviewSetup(projectId);
  const publish = usePublishSetup(projectId);
  const saveDraft = useSaveSetupDraft(projectId);

  const report = useMemo<ProbeReport | null>(() => {
    if (!wsId) return null;
    if (server)
      return (
        s.probes.find(
          (p) => p.scope === 'ssh_target' && p.workstationId === wsId && p.host === place?.host && p.report,
        )?.report ?? null
      );
    return s.probes.find((p) => p.scope === 'local' && p.workstationId === wsId && p.report)?.report ?? null;
  }, [s.probes, wsId, server, place?.host]);
  const probeRow = s.probes.find((p) =>
    server
      ? p.scope === 'ssh_target' && p.workstationId === wsId && p.host === place?.host
      : p.scope === 'local' && p.workstationId === wsId,
  );
  const homeDir = useMemo(() => {
    const p = report?.composeFiles[0]?.path ?? '';
    return /^(\/home\/[^/]+|\/Users\/[^/]+|\/root)\//.exec(p)?.[1];
  }, [report]);

  // choosing a place starts the look at it
  const askedFor = useRef('');
  const lookAt = (dir?: string) => {
    if (!wsId || (!place && !vplace)) return;
    const hints = dir
      ? { dirs: [dir], composeFiles: [`${dir}/docker-compose.yml`, `${dir}/compose.yaml`] }
      : editing
        ? { composeFiles: [editing.app.composeFile] }
        : undefined;
    if (server && place?.host)
      flow.ask({ scope: 'ssh_target', workstationId: wsId, host: place.host, ...(hints ? { hints } : {}) });
    else flow.ask({ scope: 'local', workstationId: wsId, ...(hints ? { hints } : {}) });
  };
  useEffect(() => {
    const key = `${placeId}|${wsId}|${place?.host ?? ''}`;
    if (!placeId || !wsId || askedFor.current === key) return;
    askedFor.current = key;
    lookAt();
  }, [placeId, wsId, place?.host]);

  // a server just looked at: the sites it answers on are asked about, once, so the health check can be offered
  const followUp = useRef('');
  useEffect(() => {
    const r = flow.result;
    const key = `${wsId}:${place?.host}`;
    if (!r || r.scope !== 'ssh_target' || !r.report || followUp.current === key) return;
    followUp.current = key;
    const urls = healthProbeUrls(r.report);
    const dirs = [...new Set(r.report.composeFiles.map((c) => c.path.slice(0, c.path.lastIndexOf('/'))))];
    if (urls.length && place?.host)
      flow.ask({ scope: 'ssh_target', workstationId: wsId, host: place.host, hints: { urls, dirs } });
  }, [flow.result, flow.ask, wsId, place?.host]);

  const stacks = useMemo(() => stacksFromReport(report), [report]);
  const chosenStack = stack ?? stacks.find((x) => x.path === answers.stackPath);

  const pickPlace = (id: string) => {
    setPlaceId(id);
    setChoice(null);
    setStack(undefined);
    set({ stackPath: '', runtime: 'docker' });
    askedFor.current = '';
  };
  // what the chosen place says about hosting, address and the computer that deploys (it may arrive a moment after a server is added)
  useEffect(() => {
    if (!place && !vplace) return;
    setAnswers((a) => ({
      ...a,
      hosting: place ? (place.kind === 'server' ? 'ssh' : 'this_computer') : 'this_computer',
      host: place?.host ?? '',
      targetName: place?.key ?? vplace?.name ?? '',
      workstationId: place?.workstationId ?? vplace?.workstationId ?? '',
    }));
  }, [place?.id, place?.host, vplace?.id]);
  // a server added while the dialog is open becomes the chosen place
  useEffect(() => {
    if (initialPlaceId && !placeId) pickPlace(initialPlaceId);
  }, []);

  const defaultMethod = (st: Stack, app: string): Pick<Answers, 'method' | 'registry'> => {
    const svc = st.services.find((x) => x.name === app);
    const img = svc?.image ?? '';
    const host = img.split('/')[0] ?? '';
    if (img && !img.includes('$') && img.includes('/') && (host.includes('.') || host.includes(':')))
      return { method: 'registry', registry: host };
    if (svc?.build) return { method: 'build_on_server', registry: '' };
    return { method: 'ship', registry: '' };
  };

  const pickStack = (st: Stack) => {
    const app = guessAppService(st);
    const iv = imageVarOf(report, st);
    const image = server && iv.value ? iv.value.split(':')[0] : '';
    const healthy = healthyUrls(report);
    setStack(st);
    setChoice({ kind: 'stack', path: st.path });
    const dir = st.path.slice(0, st.path.lastIndexOf('/'));
    const appUrl = server ? '' : guessAppUrl(st, app);
    set({
      runtime: 'docker',
      stackPath: st.path,
      composeProject: st.project && /^[a-z0-9][a-z0-9_-]*$/.test(st.project) ? st.project : '',
      appService: app,
      dbService: guessDbService(st),
      imageName: guessImageName(st, app, image || undefined),
      appUrl,
      imageVar: iv.name,
      backupDir: dir ? `${dir}/backups` : '',
      healthUrl: healthy[0] ?? (server ? '' : appUrl ? `${appUrl}/api/health` : ''),
      ...(server ? defaultMethod(st, app) : {}),
    });
  };
  const onSelect = (c: StartChoice) => {
    setChoice(c);
    if (c.kind === 'stack') {
      const st = stacks.find((x) => x.path === c.path);
      if (st) pickStack(st);
    } else if (c.kind === 'native') {
      const n = nativeFromApp(c.app);
      set({
        runtime: 'native',
        native: n,
        appUrl: n.port ? `http://${server ? (place?.host ?? 'localhost') : 'localhost'}:${n.port}` : '',
        healthUrl: '',
      });
    } else if (c.kind === 'typed') {
      set({ runtime: 'native', native: { ...answers.native, how: 'typed' } });
    } else set({ runtime: 'docker' });
  };

  const setRole = (role: EnvRole) => {
    const defaults = emptyAnswers(
      role,
      undefined,
      taken.filter((n) => n !== editing?.name),
    );
    const wasDefault = ['Test site', 'Live site', ''].includes(answers.label);
    set({
      role,
      trigger: defaults.trigger,
      production: role === 'live',
      ...(editing || !wasDefault ? {} : { label: defaults.label, name: defaults.name }),
    });
  };

  const testEnvName = useMemo(
    () =>
      answers.role === 'live'
        ? ((baseSetup?.environments ?? []).find((e) => e.name !== answers.name && roleOf(e) === 'test')
            ?.name ?? null)
        : null,
    [answers.role, answers.name, baseSetup],
  );
  const env = useMemo(
    () => buildEnv({ ...answers, hosting, workstationId: wsId, testEnv: testEnvName }, homeDir),
    [answers, hosting, wsId, testEnvName, homeDir],
  );
  const proposed = useMemo(() => withEnv(baseSetup, env), [baseSetup, env]);
  const changes = useMemo(
    () =>
      answers.runtime === 'native'
        ? nativeChangeItems({ ...answers, hosting })
        : planChanges({ version: 1, generator: s.generator, environments: [env] }, { [env.name]: report }),
    [env, report, s.generator, answers, hosting],
  );

  const ensurePlace = async (): Promise<string | null> => {
    try {
      if (vplace) {
        await addTarget.mutateAsync({
          name: vplace.name,
          kind: 'local_docker',
          workstationId: vplace.workstationId,
          ...(answers.appUrl ? { appUrl: answers.appUrl } : {}),
          notes: '',
          production: answers.role === 'live',
        });
        return vplace.name;
      }
      if (place) {
        const patch: Record<string, unknown> = {};
        if (answers.role === 'live' && !place.production) patch.production = true;
        if (answers.appUrl && !place.appUrl) patch.appUrl = answers.appUrl;
        if (Object.keys(patch).length) await patchTarget.mutateAsync({ id: place.id, body: patch });
        return place.key;
      }
    } catch {
      return null;
    }
    return null;
  };

  const goReview = () => {
    setStep('review');
    preview.mutate({ setup: proposed, removeFiles });
    saveDraft.mutate({ setup: proposed });
  };
  const save = async () => {
    if (!preview.data?.hash) return;
    const target = await ensurePlace();
    if (!target) return;
    const finalEnv = target === answers.targetName ? proposed : withEnv(baseSetup, { ...env, target });
    publish.mutate(
      { setup: finalEnv, setupHash: preview.data.hash, removeFiles },
      { onSuccess: (r) => setPublished(r.commandId) },
    );
  };
  const pub = s.publish;
  const written = !!published && pub?.commandId === published && pub.status === 'written';
  const failed = !!published && pub?.commandId === published && pub.status === 'failed';

  const blockers = answers.runtime === 'docker' && changes.some((c) => c.group === 'question');
  const formReady =
    !!placeId &&
    !!choice &&
    answers.label.trim().length > 0 &&
    (answers.role !== 'other' || answers.label.trim().length > 0) &&
    !(server && answers.runtime === 'docker' && answers.method === 'registry' && !answers.registry.trim()) &&
    choice.kind !== 'new';
  const detailsReady =
    answers.runtime === 'native'
      ? !!answers.native.name.trim() &&
        /^\//.test(answers.native.folder) &&
        !!answers.native.restartTarget.trim()
      : !!answers.appService && !!answers.imageName && !blockers;

  const hasTestEnv = !!testEnvName;
  const title = editing ? `Change ${editing.label}` : 'Add an environment';
  const stepNo = step === 'form' ? 1 : step === 'details' ? 2 : 3;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      size="xl"
      footer={
        step === 'form' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!formReady}
              onClick={() => setStep('details')}
              data-testid="env-next"
            >
              Next: see what we found
            </Button>
          </>
        ) : step === 'details' ? (
          <>
            <Button onClick={() => setStep('form')}>Back</Button>
            <Button variant="primary" disabled={!detailsReady} onClick={goReview} data-testid="env-to-review">
              Review
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4" data-testid="environment-dialog">
        <p className="text-xs text-subtle" role="status" aria-live="polite" data-testid="wizard-step">
          Step {stepNo} of 3:{' '}
          {step === 'form' ? 'What it is' : step === 'details' ? 'What we found' : 'Review'}
        </p>

        {step === 'form' && (
          <div className="flex flex-col gap-5">
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium text-fg">What is it for?</legend>
              {(['test', 'live', 'other'] as const).map((r) => (
                <Choice
                  key={r}
                  name="env-role"
                  checked={answers.role === r}
                  onSelect={() => setRole(r)}
                  icon={
                    r === 'test' ? (
                      <TestTube2 className="size-5" />
                    ) : r === 'live' ? (
                      <Sparkles className="size-5" />
                    ) : (
                      <Plus className="size-5" />
                    )
                  }
                  title={ROLE_COPY[r].title}
                  testId={`role-${r}`}
                >
                  {ROLE_COPY[r].text}
                </Choice>
              ))}
              {(answers.role === 'other' || editing) && (
                <TextInput
                  label={answers.role === 'other' ? 'Name it' : 'Name'}
                  value={answers.label}
                  placeholder="Demo"
                  onChange={(e) => set({ label: e.target.value })}
                  data-testid="env-label"
                />
              )}
              {answers.role === 'live' && (
                <p className="text-xs text-muted">
                  Live is never used for tests, and every release needs your approval. The test site must be
                  healthy on the same version first.
                </p>
              )}
            </fieldset>

            <fieldset className="flex flex-col gap-2" data-testid="choose-place">
              <legend className="mb-1 text-sm font-medium text-fg">Where does it run?</legend>
              {active.map((p) => (
                <Choice
                  key={p.id}
                  name="env-place"
                  checked={placeId === p.id}
                  onSelect={() => pickPlace(p.id)}
                  icon={p.kind === 'server' ? <Server className="size-5" /> : <Monitor className="size-5" />}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      {p.name}
                      <span className="font-normal text-muted">
                        ({p.kind === 'server' ? 'server' : 'this computer'})
                      </span>
                      {p.kind === 'server' && (
                        <ReachabilityChip
                          reachability={
                            p.reach
                              ? { ...p.reach, method: 'existing_alias', workstationId: p.workstationId ?? '' }
                              : null
                          }
                        />
                      )}
                    </span>
                  }
                  testId={`place-choice-${p.key}`}
                />
              ))}
              {virtual.map((v) => (
                <Choice
                  key={v.id}
                  name="env-place"
                  checked={placeId === v.id}
                  onSelect={() => pickPlace(v.id)}
                  icon={<Monitor className="size-5" />}
                  title={
                    <>
                      {v.name} <span className="font-normal text-muted">(this computer)</span>
                    </>
                  }
                  testId={`place-choice-${v.name}`}
                />
              ))}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setAddingServer(true)} data-testid="choose-add-server">
                  <Plus aria-hidden="true" className="size-4" />
                  Add a server
                </Button>
                <Link
                  to="/workstations"
                  className="inline-flex min-h-8 items-center rounded-control border border-control px-3 text-sm font-medium hover:bg-sunken"
                >
                  <Plus aria-hidden="true" className="mr-1 size-4" />
                  Add a computer
                </Link>
              </div>
              {usable.length === 0 && (
                <Callout tone="warning" title="No computer can do this yet" data-testid="no-capable-computer">
                  {s.workstations.find((w) => w.blocked)?.blocked ??
                    'Connect Guildwise on a computer of this project first.'}
                </Callout>
              )}
            </fieldset>

            {placeId && (
              <FoundApps
                group="env-start"
                server={server}
                placeName={placeName}
                loading={flow.loading}
                error={flow.error}
                errorText={probeRow?.error ? probeRow.errorText : null}
                report={report}
                selected={choice}
                onSelect={onSelect}
                onLookIn={(dir) => {
                  setFolder(dir);
                  lookAt(dir);
                }}
                onAgain={() => lookAt(folder || undefined)}
                onScan={() => scan.mutate({}, { onSuccess: onClose })}
                canStartNew={!server}
                startNew={
                  <PrepareServer
                    projectId={projectId}
                    hosting="this_computer"
                    workstationId={wsId}
                    report={report}
                    suggestedName={placeName}
                    onPrepared={(info) => {
                      setChoice(null);
                      flow.ask({
                        scope: 'local',
                        workstationId: wsId,
                        hints: { composeFiles: [info.composeFile] },
                      });
                    }}
                  />
                }
              />
            )}
            <ErrorBox error={scan.error} />

            {server && answers.runtime === 'docker' && choice?.kind === 'stack' && (
              <fieldset className="flex flex-col gap-2" data-testid="update-method">
                <legend className="mb-1 text-sm font-medium text-fg">
                  How should new versions get onto the server?
                </legend>
                {(['ship', 'registry', 'build_on_server'] as const).map((m) => (
                  <Choice
                    key={m}
                    name="env-method"
                    checked={answers.method === m}
                    onSelect={() => set({ method: m })}
                    title={METHOD_TEXT[m].title}
                    testId={`method-${m}`}
                  >
                    {METHOD_TEXT[m].text}
                  </Choice>
                ))}
                {answers.method === 'registry' && (
                  <TextInput
                    label="Registry address"
                    value={answers.registry}
                    placeholder="ghcr.io"
                    hint="Where your images are published: the address only, for example ghcr.io. The login is stored on the server, not here."
                    onChange={(e) => set({ registry: e.target.value.trim() })}
                    autoCapitalize="none"
                    data-testid="method-registry-address"
                  />
                )}
                {answers.method === 'build_on_server' && (
                  <p className="text-xs text-warning">
                    The server needs build tools and enough memory; the first build can take several minutes.
                  </p>
                )}
              </fieldset>
            )}

            {editing && place && !place.production && (
              <Disclosure summary="Used for card tests (technical settings)" data-testid="env-testing">
                <TestingSettings projectId={projectId} placeId={place.id} />
              </Disclosure>
            )}

            {choice && (
              <fieldset className="flex flex-col gap-2" data-testid="when-update">
                <legend className="mb-1 text-sm font-medium text-fg">When should it update?</legend>
                {answers.role === 'live' ? (
                  <>
                    <Callout tone="info" title="Only when you press Release">
                      The live site never updates by itself, and every release needs your approval.
                    </Callout>
                    <label className="flex min-h-11 items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1 size-4"
                        checked={answers.requireTestFirst && hasTestEnv}
                        disabled={!hasTestEnv}
                        onChange={(e) => set({ requireTestFirst: e.target.checked })}
                        data-testid="when-test-first"
                      />
                      <span>
                        <strong>Only after the test site is healthy on the same version</strong>
                        <span className="block text-muted">
                          For 10 minutes. {hasTestEnv ? '' : 'Add the test site first to use this.'}
                        </span>
                      </span>
                    </label>
                  </>
                ) : (
                  <>
                    <Choice
                      name="env-when"
                      checked={answers.trigger === 'after_merge'}
                      onSelect={() => set({ trigger: 'after_merge' })}
                      title="Automatically after each merge"
                      testId="when-auto"
                    >
                      It waits 2 minutes, so a few merges become one update.
                    </Choice>
                    <Choice
                      name="env-when"
                      checked={answers.trigger === 'on_request'}
                      onSelect={() => set({ trigger: 'on_request' })}
                      title="Only when I press Release"
                      testId="when-manual"
                    >
                      Nothing changes until you decide.
                    </Choice>
                  </>
                )}
                <p className="text-xs text-subtle">{whenText(answers.trigger)}.</p>
              </fieldset>
            )}
          </div>
        )}

        {step === 'details' &&
          (answers.runtime === 'native' ? (
            <NativeDetails
              answers={answers}
              set={set}
              setNative={setNative}
              changes={changes}
              urls={(report?.urls ?? []).filter((u) => u.status !== null)}
              onCheckUrl={(url) =>
                flow.ask({
                  scope: server ? 'ssh_target' : 'local',
                  workstationId: wsId,
                  ...(server && place?.host ? { host: place.host } : {}),
                  hints: { urls: [url] },
                })
              }
              checking={flow.loading}
            />
          ) : (
            <DockerDetails
              answers={answers}
              set={set}
              stack={chosenStack}
              report={report}
              changes={changes}
              onCheckUrl={(url) =>
                flow.ask({
                  scope: server ? 'ssh_target' : 'local',
                  workstationId: wsId,
                  ...(server && place?.host ? { host: place.host } : {}),
                  hints: { urls: [url] },
                })
              }
              checking={flow.loading}
            />
          ))}

        {step === 'review' && (
          <EnvReview
            answers={answers}
            preview={preview.data}
            previewing={preview.isPending}
            previewError={preview.error}
            changes={changes}
            publishError={publish.error ?? addTarget.error ?? patchTarget.error}
            saving={publish.isPending || addTarget.isPending || (!!published && !written && !failed)}
            written={written}
            failed={failed ? (pub?.error ?? 'The computer could not save the files.') : null}
            onSave={() => void save()}
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
        {step === 'review' && !written && (
          <div>
            <Button variant="ghost" onClick={() => setStep('details')}>
              Back
            </Button>
          </div>
        )}
        {ws && step === 'form' && !placeId && (
          <p className="text-xs text-subtle">Guildwise uses {ws.name} to look at the place you choose.</p>
        )}
      </div>
      {addingServer && (
        <AddServerDialog
          projectId={projectId}
          state={s}
          onClose={() => setAddingServer(false)}
          onAdded={(id) => {
            setAddingServer(false);
            pickPlace(id);
          }}
        />
      )}
    </Dialog>
  );
}

/** The tester's settings for the place (merged here from the old target panel): may the tester use it, may tests change data. */
function TestingSettings({ projectId, placeId }: { projectId: string; placeId: string }) {
  const targets = useDeployTargets(projectId);
  const ws = useProjectWorkstations(projectId);
  const target = (targets.data ?? []).find((t) => t.id === placeId);
  if (!target) return null;
  return <TargetTesting projectId={projectId} target={target} workstations={ws.data ?? []} />;
}
