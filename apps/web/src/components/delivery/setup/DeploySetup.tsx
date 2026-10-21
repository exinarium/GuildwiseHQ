import type { ProposalDto, SetupEnv, SetupStateDto } from '@aom/shared';
import { describeSetupStep, RETIRE_EXPLAINER } from '@aom/shared';
import {
  ArrowRightLeft,
  Eye,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  ScanSearch,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApproveRecipe } from '../../../api/queries/delivery.ts';
import { openMove, useMoves, useRetire } from '../../../api/queries/deploy-move.ts';
import {
  usePreviewSetup,
  useProbe,
  usePublishSetup,
  useSetupDryRun,
  useSetupState,
  useStartDeployScan,
  useUseDeployProposal,
} from '../../../api/queries/deploy-setup.ts';
import { useDismissProposal } from '../../../api/queries/run-plan.ts';
import { ProposalReview, type ReviewQuestion } from '../../setup/ProposalReview.tsx';
import { Badge, Button, Callout, Dialog, ErrorBox, Panel, Spinner, useToast } from '../../ui.tsx';
import { ConnectServer } from '../connect/ConnectServer.tsx';
import { needsReconnect, ReachabilityChip } from '../connect/ReachabilityChip.tsx';
import { MoveWizard } from '../move/MoveWizard.tsx';
import { AdvancedSetup } from './AdvancedSetup.tsx';
import { DeployWizard } from './DeployWizard.tsx';
import { whenText } from './model.ts';

type Mode =
  | { kind: 'overview' }
  | { kind: 'wizard'; edit?: SetupEnv; purpose?: 'test' | 'live' }
  | { kind: 'advanced' }
  | { kind: 'scan' };

/**
 * Phases and deploys > Set up deploys (docs/design/deploy-run-ux-design.md section 3.2): the overview of the environments (what
 * runs where, which computer deploys it and whether it can sign in, when it updates, the approval state), the guided wizard,
 * the review of a DevOps scan, and the developer view of the same setup. Writing is always "Save", then a dry run, then the
 * Owner's approval of exactly that version.
 */
export function DeploySetup({ projectId }: { projectId: string }) {
  const q = useSetupState(projectId);
  const [mode, setMode] = useState<Mode>({ kind: 'overview' });
  if (q.isPending) return <Spinner label="Loading the deploy setup" />;
  if (q.isError || !q.data)
    return (
      <Panel>
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </Panel>
    );
  const s = q.data;
  const back = () => setMode({ kind: 'overview' });
  return (
    <Panel data-testid="deploy-setup">
      {mode.kind === 'overview' && (
        <Overview
          projectId={projectId}
          s={s}
          onWizard={(edit, purpose) =>
            setMode({ kind: 'wizard', ...(edit ? { edit } : {}), ...(purpose ? { purpose } : {}) })
          }
          onAdvanced={() => setMode({ kind: 'advanced' })}
          onScan={() => setMode({ kind: 'scan' })}
        />
      )}
      {mode.kind === 'wizard' && (
        <DeployWizard
          projectId={projectId}
          state={s}
          editing={mode.edit}
          initialPurpose={mode.purpose}
          onClose={back}
          onAdvanced={() => setMode({ kind: 'advanced' })}
        />
      )}
      {mode.kind === 'advanced' && <AdvancedSetup projectId={projectId} state={s} onClose={back} />}
      {mode.kind === 'scan' && s.proposal && (
        <DeployScanReview
          projectId={projectId}
          proposal={s.proposal}
          onDone={(edit) => setMode(edit ? { kind: 'wizard', edit } : { kind: 'overview' })}
          onBack={back}
        />
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ overview

function Overview({
  projectId,
  s,
  onWizard,
  onAdvanced,
  onScan,
}: {
  projectId: string;
  s: SetupStateDto;
  onWizard: (edit?: SetupEnv, purpose?: 'test' | 'live') => void;
  onAdvanced: () => void;
  onScan: () => void;
}) {
  const envs = s.current.setup?.environments ?? [];
  const scan = useStartDeployScan(projectId);
  const toast = useToast();
  const noneCan = s.workstations.length > 0 && s.workstations.every((w) => !w.canProbe);
  const dirty = !!s.draft?.setup && JSON.stringify(s.draft.setup) !== JSON.stringify(s.current.setup);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-fg">Set up deploys</h2>
        <p className="text-sm text-muted">
          Where your app runs and how it is updated. Guildwise looks at what is already there, shows what it
          found and what it will change, and only changes something after you confirm and the Owner approves.
        </p>
      </div>

      {noneCan && (
        <Callout
          tone="warning"
          title="Guildwise on your computer needs an update for guided setup"
          data-testid="setup-runner-old"
        >
          {s.workstations.find((w) => w.blocked)?.blocked} The developer view below still works.
        </Callout>
      )}
      {s.writeBlocked && !noneCan && (
        <Callout tone="warning" title="Saving is not possible yet" data-testid="setup-write-blocked">
          {s.writeBlocked}
        </Callout>
      )}

      {s.scan && (
        <Callout tone="info" title="DevOps is looking" data-testid="deploy-scan-progress">
          <div className="flex items-center gap-2">
            <Spinner inline label="Scanning" />
            On {s.scan.workstationName}, usually 2 to 5 minutes. You can leave this page.
          </div>
        </Callout>
      )}
      {!s.scan && s.scanProblem && (
        <Callout tone="warning" title="The scan did not give a result" data-testid="deploy-scan-problem">
          {s.scanProblem}
        </Callout>
      )}
      {s.proposal && (
        <Callout
          tone="info"
          title="DevOps has a suggestion for your deploys"
          data-testid="deploy-proposal-waiting"
          actions={
            s.canEdit ? (
              <Button size="sm" variant="primary" onClick={onScan} data-testid="deploy-proposal-open">
                Review
              </Button>
            ) : undefined
          }
        >
          {s.proposal.proposal.deploy?.environments.length ?? 0}{' '}
          {(s.proposal.proposal.deploy?.environments.length ?? 0) === 1 ? 'environment' : 'environments'}
          {s.proposal.proposal.questions.length
            ? `, ${s.proposal.proposal.questions.length} questions for you`
            : ''}
          .
        </Callout>
      )}
      {dirty && s.canEdit && (
        <Callout tone="info" title="You have an unfinished setup" data-testid="setup-draft">
          Saved as a draft {s.draft ? new Date(s.draft.updatedAt).toLocaleString() : ''}. Nothing from it is
          in the project yet.{' '}
          <button type="button" className="underline" onClick={onAdvanced}>
            Review it
          </button>
        </Callout>
      )}
      {s.publish?.status === 'failed' && (
        <Callout tone="danger" title="The last save did not work" data-testid="setup-publish-failed">
          {s.publish.error}
        </Callout>
      )}
      {s.publish?.status === 'pending' && (
        <Callout tone="info" title="Saving to the project's files" data-testid="setup-publish-pending">
          <div className="flex items-center gap-2">
            <Spinner inline label="Saving" />
            The computer is writing the steps...
          </div>
        </Callout>
      )}

      {s.improvedAvailable && s.current.setup && <ImprovedSteps projectId={projectId} s={s} />}

      {envs.length === 0 && !s.current.custom ? (
        <div
          className="flex flex-col gap-3 rounded-control border border-dashed border-line p-4"
          data-testid="setup-empty"
        >
          <p className="text-sm text-fg">
            <strong>Your app is not deployed anywhere yet.</strong>
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="primary"
              onClick={() => onWizard(undefined, 'test')}
              disabled={!s.canEdit}
              data-testid="setup-start"
            >
              <Plus aria-hidden="true" className="size-4" />
              Set up deploys
            </Button>
            <Button
              onClick={() => scan.mutate({}, { onSuccess: () => toast.success('DevOps is looking') })}
              loading={scan.isPending}
              disabled={!s.canEdit || !!s.scan}
              data-testid="setup-scan"
            >
              <ScanSearch aria-hidden="true" className="size-4" />
              Let DevOps look at it first
            </Button>
          </div>
          <ErrorBox error={scan.error} />
          {!s.canEdit && <p className="text-xs text-subtle">Only the project owner sets up deploys.</p>}
        </div>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="setup-envs">
          {envs.map((e) => (
            <EnvCard key={e.name} projectId={projectId} s={s} env={e} onEdit={() => onWizard(e)} />
          ))}
        </ul>
      )}
      <OldServers projectId={projectId} s={s} />

      {s.current.custom && (
        <Callout tone="info" title="This recipe is a script" data-testid="setup-custom">
          The deploy files were written by hand or by DevOps, so they are shown as scripts. Let DevOps turn
          them into guided steps, or use the developer view.
          <div className="mt-2">
            <Button
              size="sm"
              onClick={() => scan.mutate({}, { onSuccess: () => toast.success('DevOps is looking') })}
              loading={scan.isPending}
              disabled={!s.canEdit || !!s.scan}
            >
              <ScanSearch aria-hidden="true" className="size-4" />
              Scan with DevOps
            </Button>
          </div>
        </Callout>
      )}

      {envs.length > 0 && <Approval projectId={projectId} s={s} />}

      {s.canEdit && (
        <div className="flex flex-col gap-2 border-t border-line pt-3 sm:flex-row sm:flex-wrap">
          {envs.length > 0 && (
            <Button
              onClick={() => onWizard(undefined, envs.some((e) => e.name === 'uat') ? 'live' : 'test')}
              data-testid="setup-add"
            >
              <Plus aria-hidden="true" className="size-4" />
              Add {envs.some((e) => e.name === 'uat') ? 'the live site' : 'a test copy'}
            </Button>
          )}
          {envs.length > 0 && (
            <Button
              onClick={() => scan.mutate({}, { onSuccess: () => toast.success('DevOps is looking') })}
              loading={scan.isPending}
              disabled={!!s.scan}
            >
              <ScanSearch aria-hidden="true" className="size-4" />
              Scan with DevOps
            </Button>
          )}
          <Button variant="ghost" onClick={onAdvanced} data-testid="setup-advanced">
            Show technical details
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * "An improved version of these steps is available" (design v2): Guildwise's generator changed since these scripts were made.
 * Nothing changes by itself; updating writes the same setup again with the newer generator and needs the Owner's approval.
 */
function ImprovedSteps({ projectId, s }: { projectId: string; s: SetupStateDto }) {
  const preview = usePreviewSetup(projectId);
  const publish = usePublishSetup(projectId);
  const [done, setDone] = useState(false);
  const run = () =>
    preview.mutate(
      { setup: s.current.setup },
      {
        onSuccess: (p) => {
          if (!p.ok || !p.hash) return;
          publish.mutate({ setup: s.current.setup, setupHash: p.hash }, { onSuccess: () => setDone(true) });
        },
      },
    );
  return (
    <Callout
      tone="info"
      title="An improved version of these steps is available"
      data-testid="setup-improved"
      actions={
        s.canEdit && !done ? (
          <Button
            size="sm"
            variant="primary"
            onClick={run}
            loading={preview.isPending || publish.isPending}
            data-testid="setup-improved-update"
          >
            Update the steps
          </Button>
        ) : undefined
      }
    >
      {done
        ? 'Saved. The new version of the steps needs the Owner’s approval (and a try-out) before it is used.'
        : 'Your steps were made by an older version of Guildwise. Updating keeps your choices and changes only how the steps are written (for example how a failed update is undone). The Owner approves the new version before anything runs.'}
      <ErrorBox error={preview.error ?? publish.error} />
    </Callout>
  );
}

function EnvCard({
  projectId,
  s,
  env,
  onEdit,
}: {
  projectId: string;
  s: SetupStateDto;
  env: SetupEnv;
  onEdit: () => void;
}) {
  const target = s.targets.find((t) => t.name.toLowerCase() === env.target.toLowerCase());
  const probe = useProbe(projectId);
  const handEdited = s.current.handEdited.includes(env.name);
  const reach = target?.connection
    ? {
        state: target.connection.state,
        at: target.connection.at,
        detail: target.connection.detail,
        method: target.connection.method ?? ('existing_alias' as const),
        workstationId: target.workstationId ?? '',
      }
    : null;
  const [reconnect, setReconnect] = useState(false);
  const [moving, setMoving] = useState(false);
  const movesQ = useMoves(projectId);
  const moveOpen = openMove(movesQ.data)?.envName === env.name ? openMove(movesQ.data) : undefined;
  // a move that was open when the dialog was opened stays on screen when it ends (the "it is live" message)
  const [followId, setFollowId] = useState<string | null>(null);
  useEffect(() => {
    if (moveOpen) setFollowId(moveOpen.id);
  }, [moveOpen]);
  const shownMove =
    moveOpen ?? (moving ? movesQ.data?.find((m) => m.id === followId && m.state === 'completed') : undefined);
  const mover = s.workstations.find((w) => w.id === target?.workstationId);
  // an older server does not tell the role of a target: then there are no moves either
  const canMove =
    env.hosting === 'ssh' &&
    env.mode === 'guided' &&
    !!target &&
    target.role === 'active' &&
    target.kind === 'remote_ssh' &&
    !!mover?.canMove;
  const status = s.current.recipeStatus;
  const approvalText = !s.current.recipePresent
    ? 'Not saved yet'
    : status === 'approved'
      ? 'Approved'
      : status === 'changed_unapproved'
        ? 'Changed since approval: needs the Owner'
        : 'Waiting for the Owner';
  return (
    <li
      className="flex flex-col gap-2 rounded-control border border-line p-3"
      data-testid={`env-card-${env.name}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {env.hosting === 'ssh' ? (
          <Server aria-hidden="true" className="size-4 text-muted" />
        ) : (
          <Monitor aria-hidden="true" className="size-4 text-muted" />
        )}
        <h3 className="text-base font-semibold text-fg">{env.label}</h3>
        {target?.production && <Badge tone="danger">Production</Badge>}
        {env.mode === 'custom' && <Badge tone="amber">Edited by hand</Badge>}
        {handEdited && env.mode === 'guided' && <Badge tone="amber">Script edited by hand</Badge>}
      </div>
      <p className="text-sm text-muted">
        {env.hosting === 'ssh' ? `On the server ${env.host}` : 'On this computer'}.{' '}
        {whenText(env.trigger[0] ?? 'on_request')}.
      </p>
      <p
        className="flex flex-wrap items-center gap-2 text-sm text-muted"
        data-testid={`env-deploys-from-${env.name}`}
      >
        Deploys from{' '}
        <strong className="text-fg">{target?.workstationName ?? 'any computer of the project'}</strong>
        {target?.workstationOnline !== null && target?.workstationOnline !== undefined && (
          <Badge tone={target.workstationOnline ? 'green' : 'neutral'}>
            {target.workstationOnline ? 'Online' : 'Offline'}
          </Badge>
        )}
        {env.hosting === 'ssh' && <ReachabilityChip reachability={reach} />}
      </p>
      {handEdited && env.mode === 'guided' && (
        <p className="text-xs text-warning" data-testid={`env-hand-edited-${env.name}`}>
          The script of this part was edited by hand, so it is shown as a script. "Back to guided" in the
          technical details regenerates it and needs a new approval.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-subtle">
        <span>Approval: {approvalText}</span>
      </div>
      {s.canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={onEdit}
            disabled={env.mode === 'custom'}
            data-testid={`env-edit-${env.name}`}
          >
            <Pencil aria-hidden="true" className="size-4" />
            Edit
          </Button>
          {env.hosting === 'ssh' && target && (
            <Button
              size="sm"
              variant="ghost"
              loading={probe.isPending}
              onClick={() =>
                probe.mutate({
                  scope: 'ssh_target',
                  targetId: target.id,
                  ...(target.workstationId ? { workstationId: target.workstationId } : {}),
                })
              }
              data-testid={`env-check-${env.name}`}
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              Check connection
            </Button>
          )}
          {(canMove || moveOpen) && (
            <Button
              size="sm"
              variant={moveOpen ? 'primary' : 'secondary'}
              onClick={() => setMoving(true)}
              data-testid={`env-move-${env.name}`}
            >
              <ArrowRightLeft aria-hidden="true" className="size-4" />
              {moveOpen ? 'Continue the move' : 'Move to a new server'}
            </Button>
          )}
          {env.hosting === 'ssh' && target && needsReconnect(reach) && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => setReconnect(true)}
              data-testid={`env-reconnect-${env.name}`}
            >
              Reconnect from this computer
            </Button>
          )}
        </div>
      )}
      <ErrorBox error={probe.error} />
      {moving && target && (
        <Dialog
          open
          onOpenChange={(o) => !o && setMoving(false)}
          title={`Move ${env.label} to a new server`}
          size="lg"
        >
          <MoveWizard
            projectId={projectId}
            s={s}
            env={env}
            from={target}
            move={shownMove}
            moves={movesQ.data ?? []}
            onClose={() => setMoving(false)}
          />
        </Dialog>
      )}
      {reconnect && target && (
        <Dialog
          open
          onOpenChange={(o) => !o && setReconnect(false)}
          title={`Reconnect ${target.name}`}
          size="lg"
        >
          <ConnectServer
            heading={false}
            projectId={projectId}
            target={{
              id: target.id,
              name: target.name,
              host: target.host,
              workstationId: target.workstationId,
              keys: target.keys ?? [],
            }}
            onCancel={() => setReconnect(false)}
            onDone={() => setReconnect(false)}
          />
        </Dialog>
      )}
    </li>
  );
}

/** Dry run per guided environment, then the Owner's approval of exactly this version. */
function Approval({ projectId, s }: { projectId: string; s: SetupStateDto }) {
  const dry = useSetupDryRun(projectId);
  const approve = useApproveRecipe(projectId);
  const toast = useToast();
  // every environment of this version is tried (also a script edited by hand or written by someone else)
  const labels = new Map((s.current.setup?.environments ?? []).map((e) => [e.name, e.label]));
  const required = s.current.dryRunMissing ?? [];
  const guided = (s.current.envNames ?? [...labels.keys()]).map((name) => ({
    name,
    label: labels.get(name) ?? name,
  }));
  if (
    !s.current.recipePresent ||
    s.current.recipeStatus === 'approved' ||
    !s.current.observedHash ||
    guided.length === 0
  )
    return null;
  const missing = guided.filter(
    (e) => required.includes(e.name) || (!s.current.dryRunMissing && !s.current.dryRunOk.includes(e.name)),
  );
  const errors = s.current.lint.filter((l) => l.level === 'error');
  return (
    <section
      className="flex flex-col gap-3 rounded-control border border-line p-3"
      data-testid="setup-approval"
    >
      <h3 className="text-base font-semibold text-fg">Before it can be used</h3>
      <ol className="flex flex-col gap-2 text-sm">
        {guided.map((e) => {
          const ok = !missing.some((m) => m.name === e.name);
          return (
            <li key={e.name} className="flex flex-wrap items-center gap-2" data-testid={`dryrun-${e.name}`}>
              <Badge tone={ok ? 'green' : 'neutral'}>{ok ? 'Tried: OK' : 'Not tried yet'}</Badge>
              <span>{e.label}</span>
              {!ok && s.canEdit && (
                <Button
                  size="sm"
                  loading={dry.isPending && dry.variables === e.name}
                  onClick={() => dry.mutate(e.name)}
                  data-testid={`dryrun-run-${e.name}`}
                >
                  <Eye aria-hidden="true" className="size-4" />
                  Try it without changing anything
                </Button>
              )}
            </li>
          );
        })}
      </ol>
      {dry.data && (
        <p className="text-xs text-muted" role="status" data-testid="dryrun-message">
          {dry.data.message}
        </p>
      )}
      <ErrorBox error={dry.error} />
      {errors.length > 0 && <p className="text-sm text-danger">{errors[0]?.message}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={!s.canApprove || missing.length > 0 || errors.length > 0}
          loading={approve.isPending}
          onClick={() =>
            approve.mutate(s.current.observedHash as string, { onSuccess: () => toast.success('Approved') })
          }
          data-testid="setup-approve"
        >
          <ShieldCheck aria-hidden="true" className="size-4" />
          Approve this version
        </Button>
        {!s.canApprove && <span className="text-xs text-subtle">Waiting for the Owner's approval.</span>}
        {s.canApprove && missing.length > 0 && (
          <span className="text-xs text-subtle">Try it without changing anything first.</span>
        )}
      </div>
      <ErrorBox error={approve.error} />
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ scan review

function DeployScanReview({
  projectId,
  proposal,
  onDone,
  onBack,
}: {
  projectId: string;
  proposal: ProposalDto;
  onDone: (edit?: SetupEnv) => void;
  onBack: () => void;
}) {
  const use = useUseDeployProposal(projectId);
  const dismiss = useDismissProposal(projectId);
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const envs = proposal.proposal.deploy?.environments ?? [];
  const confidence = (path: string) => {
    const worst = (['unknown', 'guessed', 'found'] as const).find((c) =>
      proposal.proposal.items.some(
        (i) => (i.path === path || i.path.startsWith(`${path}/`)) && i.confidence === c,
      ),
    );
    return worst ?? null;
  };
  const questions: ReviewQuestion[] = proposal.proposal.questions.map((qn) => ({
    ...qn,
    answered: answered.has(qn.path),
    onAnswer: () => setAnswered((a) => new Set(a).add(qn.path)),
  }));
  return (
    <ProposalReview
      proposal={proposal}
      questions={questions}
      blocking={questions.filter((x) => !x.answered).length}
      useLabel="Use this setup"
      busy={use.isPending || dismiss.isPending}
      onUse={() => use.mutate(proposal.id, { onSuccess: () => onDone(envs[0]) })}
      onDismiss={() => dismiss.mutate(proposal, { onSuccess: onBack })}
      testSlot={<ErrorBox error={use.error ?? dismiss.error} />}
    >
      <section className="flex flex-col gap-3" data-testid="deploy-proposal-envs">
        {envs.map((e, i) => {
          const c = confidence(`/environments/${i}`);
          return (
            <div key={e.name} className="rounded-control border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-base font-semibold text-fg">{e.label}</h4>
                {c && (
                  <Badge tone={c === 'found' ? 'green' : c === 'guessed' ? 'amber' : 'red'}>
                    {c === 'found' ? 'Found' : c === 'guessed' ? 'Guessed: please check' : 'Unknown'}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted">
                {e.hosting === 'ssh' ? `On the server ${e.host}` : 'On this computer'}, target {e.target}.
                Updates app part "{e.app.service}" of {e.app.composeFile}.
              </p>
              <ul className="mt-1 list-disc pl-5 text-sm text-muted">
                {e.steps.map((st, n) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a step has no id
                  <li key={n}>{describeSetupStep(st, e)}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>
    </ProposalReview>
  );
}

/**
 * The old servers of finished moves: a standby is a fallback that nothing deploys to; the Owner can retire it, which only
 * removes the keys Guildwise added to it (nothing on the server is deleted, ever).
 */
export function OldServers({ projectId, s }: { projectId: string; s: SetupStateDto }) {
  const old = s.targets.filter((t) => t.role === 'standby' || t.role === 'retired');
  const retire = useRetire(projectId);
  const [asking, setAsking] = useState<string | null>(null);
  const toast = useToast();
  if (old.length === 0) return null;
  const target = old.find((t) => t.id === asking);
  return (
    <section className="flex flex-col gap-2" data-testid="old-servers">
      <h3 className="text-base font-semibold text-fg">Old servers</h3>
      <ul className="flex flex-col gap-2">
        {old.map((t) => (
          <li
            key={t.id}
            className="flex flex-col gap-1.5 rounded-control border border-line p-3"
            data-testid={`old-server-${t.id}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Server aria-hidden="true" className="size-4 text-muted" />
              <span className="font-medium text-fg">{t.name}</span>
              <Badge tone={t.role === 'standby' ? 'amber' : 'neutral'} data-testid="old-server-role">
                {t.role === 'standby' ? 'Standby (fallback)' : 'Retired'}
              </Badge>
            </div>
            <p className="text-sm text-muted">
              {t.role === 'standby'
                ? 'Nothing deploys here any more. Its data, app and backup from the move are untouched, so you can fall back to it. Retire it when you are sure.'
                : 'Guildwise can no longer sign in to this server. Nothing on it was deleted.'}
            </p>
            {t.role === 'standby' && (
              <div>
                {s.canApprove ? (
                  <Button size="sm" onClick={() => setAsking(t.id)} data-testid={`retire-${t.id}`}>
                    Retire
                  </Button>
                ) : (
                  <p className="text-xs text-subtle">Only the Owner retires a server.</p>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      <ErrorBox error={retire.error} />
      <Dialog
        open={!!target}
        onOpenChange={(o) => !o && setAsking(null)}
        title={`Retire ${target?.name ?? ''}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsking(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={retire.isPending}
              onClick={() =>
                target &&
                retire.mutate(target.id, {
                  onSuccess: () => {
                    setAsking(null);
                    toast.success('Removing the Guildwise keys from the old server');
                  },
                })
              }
              data-testid="retire-confirm"
            >
              Retire the old server
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm text-muted" data-testid="retire-explainer">
          {RETIRE_EXPLAINER.map((t) => (
            <p key={t}>{t}</p>
          ))}
        </div>
      </Dialog>
    </section>
  );
}
