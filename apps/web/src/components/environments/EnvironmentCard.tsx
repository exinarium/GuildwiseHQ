import type { SetupEnv, SetupStateDto } from '@aom/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowRightLeft,
  Eye,
  History,
  Monitor,
  Pencil,
  RefreshCw,
  Rocket,
  Server,
  ShieldCheck,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApproveRecipe, useDeploy } from '../../api/queries/delivery.ts';
import { useCheckTarget } from '../../api/queries/deploy-connect.ts';
import { openMove, useMoves } from '../../api/queries/deploy-move.ts';
import { useProbe, useSetupDryRun } from '../../api/queries/deploy-setup.ts';
import { type EnvStatusDto, statusKey } from '../../api/queries/environments.ts';
import { ConnectServer } from '../delivery/connect/ConnectServer.tsx';
import { needsReconnect, ReachabilityChip } from '../delivery/connect/ReachabilityChip.tsx';
import { MoveWizard } from '../delivery/move/MoveWizard.tsx';
import { FixWithDevOps } from '../devops/FixWithDevOps.tsx';
import { Badge, Button, Callout, Dialog, ErrorBox, Menu, MenuItem, MenuSeparator, useToast } from '../ui.tsx';
import { AddServerDialog } from './AddPlaceDialogs.tsx';
import { directRestartWords, nativeOf } from './answers.ts';
import { EnvironmentDialog } from './EnvironmentDialog.tsx';
import {
  agoText,
  cardInfo,
  hostOf,
  howItStarts,
  type PlaceVm,
  ROLE_TITLE,
  rulesOf,
  updateRuleText,
} from './model.ts';
import { ReleaseSheet } from './ReleaseSheet.tsx';
import { ChangePlaceDialog, RemoveEnvironmentDialog } from './RemoveDialogs.tsx';
import { RollbackSheet } from './RollbackSheet.tsx';
import { StatusStrip } from './StatusStrip.tsx';

/**
 * One environment (docs/design/environments-ux.md section 3): its name, status chip, place, address, the update rule, the
 * rules, one sentence about where it is, the Saved / Tried / Approved strip and exactly one primary action. Everything else is
 * behind the "..." menu. The same card serves a Docker app and an app that runs directly on the machine.
 */
export function EnvironmentCard({
  projectId,
  s,
  env,
  draft,
  places,
  status,
  hasPlan,
  labelOf,
  changesSinceApproval,
  onAdvanced,
  onAnswer,
}: {
  projectId: string;
  s: SetupStateDto;
  env: SetupEnv;
  draft: boolean;
  places: PlaceVm[];
  status: EnvStatusDto | undefined;
  hasPlan: boolean;
  labelOf: (name: string) => string;
  changesSinceApproval: string[];
  onAdvanced: () => void;
  /** Open the questions DevOps asked. */
  onAnswer?: (() => void) | undefined;
}) {
  const place = places.find((p) => p.key.toLowerCase() === env.target.toLowerCase());
  const info = cardInfo({ s, env, draft, place, status });
  const toast = useToast();
  const qc = useQueryClient();
  const dry = useSetupDryRun(projectId);
  const approve = useApproveRecipe(projectId);
  const deploy = useDeploy(projectId);
  const check = useCheckTarget(projectId);
  const probe = useProbe(projectId);
  const [releasing, setReleasing] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [approving, setApproving] = useState(false);
  const [reconnect, setReconnect] = useState(false);
  const [moving, setMoving] = useState(false);
  const [tried, setTried] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [changing, setChanging] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [addingServer, setAddingServer] = useState(false);
  const onEdit = () => setEditing(true);
  const onChangePlace = () => setChanging(true);
  const onRemove = () => setRemoving(true);
  const onBackToGuided = onAdvanced;
  const movesQ = useMoves(projectId);
  const moveOpen = openMove(movesQ.data)?.envName === env.name ? openMove(movesQ.data) : undefined;
  const [followId, setFollowId] = useState<string | null>(null);
  useEffect(() => {
    if (moveOpen) setFollowId(moveOpen.id);
  }, [moveOpen]);
  const shownMove =
    moveOpen ?? (moving ? movesQ.data?.find((m) => m.id === followId && m.state === 'completed') : undefined);
  const mover = s.workstations.find((w) => w.id === place?.workstationId);
  const target = s.targets.find((t) => t.id === place?.id);
  const canMove =
    env.hosting === 'ssh' &&
    env.mode === 'guided' &&
    !nativeOf(env) &&
    !!env.app.imageVar &&
    !!target &&
    target.role === 'active' &&
    target.kind === 'remote_ssh' &&
    !!mover?.canMove;
  const native = nativeOf(env);
  const reach = place?.reach
    ? {
        state: place.reach.state,
        at: place.reach.at,
        detail: place.reach.detail,
        method: target?.connection?.method ?? ('existing_alias' as const),
        workstationId: place.workstationId ?? '',
      }
    : null;
  const canEdit = s.canEdit;
  const rules = info.role === 'live' || env.gate !== 'none' ? rulesOf(env, labelOf) : [];
  const waiting = status?.waitingRelease;
  const headingId = `env-${env.name}-title`;
  const nextText = null;
  const url = status?.appUrl ?? env.app.appUrl ?? place?.appUrl ?? null;
  const missingElsewhere = (s.current.dryRunMissing ?? []).filter((n) => n !== env.name);

  const doTry = () =>
    dry.mutate(env.name, {
      onSuccess: (r) => {
        setTried(r.message);
        toast.success('Tried: nothing was changed');
      },
    });
  const doUpdate = () =>
    deploy.mutate(
      { env: env.name },
      {
        onSuccess: (r) => {
          toast.success(r.message || 'Updating');
          void qc.invalidateQueries({ queryKey: statusKey(projectId) });
        },
      },
    );

  return (
    <li
      className="flex list-none flex-col gap-3 rounded-card border border-line bg-surface p-4"
      data-testid={`env-card-${env.name}`}
    >
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {native || env.hosting === 'this_computer' ? (
            <Monitor aria-hidden="true" className="size-4 shrink-0 text-muted" />
          ) : (
            <Server aria-hidden="true" className="size-4 shrink-0 text-muted" />
          )}
          <h3 id={headingId} className="text-base font-semibold text-fg [overflow-wrap:anywhere]">
            {info.label}
          </h3>
          {info.label !== ROLE_TITLE[info.role] && <Badge>{ROLE_TITLE[info.role]}</Badge>}
          <Badge tone={info.chip.tone} data-testid={`env-chip-${env.name}`}>
            {info.chip.label}
          </Badge>
          {status?.version && info.strip.approved && (
            <span className="tnum ml-auto text-sm text-muted">v{status.version.replace(/^v/, '')}</span>
          )}
        </div>

        <dl className="grid gap-x-4 gap-y-1 text-sm grid-cols-[5.5rem_1fr]">
          <dt className="text-subtle">Place</dt>
          <dd className="min-w-0 text-fg" data-testid={`env-place-${env.name}`}>
            {place ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">{place.name}</span>
                <span className="text-muted">({place.what})</span>
                {place.kind === 'server' && <ReachabilityChip reachability={reach} />}
              </span>
            ) : (
              <span className="text-muted">Not connected yet</span>
            )}
          </dd>
          {url && (
            <>
              <dt className="text-subtle">Address</dt>
              <dd className="min-w-0 [overflow-wrap:anywhere]">
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand underline-offset-2 hover:underline"
                >
                  {hostOf(url)}
                </a>
              </dd>
            </>
          )}
          <dt className="text-subtle">Updates</dt>
          <dd className="text-fg">{updateRuleText(env)}</dd>
          <dt className="text-subtle">How</dt>
          <dd className="text-muted" data-testid={`env-how-${env.name}`}>
            {native
              ? `Runs directly on ${place?.kind === 'server' ? 'the server' : 'this computer'}: ${env.app.imageName} in ${native.currentLink ?? native.appDir}${portOf(env.app.appUrl) ? `, port ${portOf(env.app.appUrl)}` : ''}. Each update gets the new version, builds it, switches to it and will ${directRestartWords(native)}. The last ${native.keep} versions are kept.`
              : howItStarts(env, hasPlan)}
          </dd>
          {rules.length > 0 && (
            <>
              <dt className="text-subtle">Rules</dt>
              <dd className="text-fg" data-testid={`env-rules-${env.name}`}>
                {rules.join(' · ')}
              </dd>
            </>
          )}
        </dl>

        <p
          className="text-sm text-fg"
          role={info.state === 'failed' ? 'alert' : 'status'}
          data-testid={`env-sentence-${env.name}`}
        >
          {info.sentence}
        </p>

        {(draft || !info.strip.approved) && info.state !== 'custom' && info.state !== 'updating' && (
          <StatusStrip name={env.name} strip={info.strip} next={nextText} />
        )}

        {tried && (
          <p
            className="rounded-control bg-sunken px-3 py-2 text-sm text-muted"
            role="status"
            data-testid={`env-tried-${env.name}`}
          >
            {tried}
          </p>
        )}

        {info.state === 'failed' && place?.workstationId && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <FixWithDevOps
              workstationId={place.workstationId}
              problem={`The update of ${info.label} failed`}
              errorText={info.sentence}
              projectId={projectId}
              onDone={() => qc.invalidateQueries({ queryKey: statusKey(projectId) })}
              doneLabel="Check again"
              label="Fix with DevOps"
            />
          </div>
        )}

        {env.mode === 'guided' && s.current.handEdited.includes(env.name) && (
          <p className="text-xs text-warning" data-testid={`env-hand-edited-${env.name}`}>
            The script of this part was edited by hand, so it is shown as a script. "Back to guided" in the
            technical details regenerates it and needs a new approval.
          </p>
        )}

        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2" data-testid={`env-actions-${env.name}`}>
            {info.action === 'answer' && onAnswer && (
              <Button variant="primary" onClick={onAnswer} data-testid={`env-answer-${env.name}`}>
                Answer
              </Button>
            )}
            {info.action === 'review' && (
              <Button variant="primary" onClick={onEdit} data-testid={`env-review-${env.name}`}>
                Review and save
              </Button>
            )}
            {info.action === 'try' && (
              <Button
                variant="primary"
                loading={dry.isPending}
                onClick={doTry}
                data-testid={`env-try-${env.name}`}
              >
                <Eye aria-hidden="true" className="size-4" />
                Try it without changing anything
              </Button>
            )}
            {info.action === 'approve' && (
              <Button
                variant="primary"
                disabled={!s.canApprove || missingElsewhere.length > 0}
                onClick={() => setApproving(true)}
                data-testid={`env-approve-${env.name}`}
              >
                <ShieldCheck aria-hidden="true" className="size-4" />
                Approve
              </Button>
            )}
            {info.action === 'update' && (
              <Button
                variant="primary"
                loading={deploy.isPending}
                onClick={doUpdate}
                data-testid={`env-update-${env.name}`}
              >
                <RefreshCw aria-hidden="true" className="size-4" />
                Update now
              </Button>
            )}
            {info.action === 'release' && waiting && (
              <Button
                variant="primary"
                onClick={() => setReleasing(true)}
                data-testid={`env-release-${env.name}`}
              >
                <Rocket aria-hidden="true" className="size-4" />
                Release {waiting.version ?? 'the new version'}
              </Button>
            )}
            {info.action === 'check' && place && (
              <Button
                variant="primary"
                loading={check.isPending || probe.isPending}
                onClick={() =>
                  place.kind === 'server'
                    ? check.mutate(place.id, { onSuccess: () => toast.success('Checking the connection') })
                    : probe.mutate({
                        scope: 'local',
                        ...(place.workstationId ? { workstationId: place.workstationId } : {}),
                      })
                }
                data-testid={`env-check-${env.name}`}
              >
                <RefreshCw aria-hidden="true" className="size-4" />
                Check again
              </Button>
            )}
            {(info.action === 'reconnect' || (place?.kind === 'server' && needsReconnect(reach))) &&
              target && (
                <Button
                  variant={info.action === 'reconnect' ? 'primary' : 'secondary'}
                  onClick={() => setReconnect(true)}
                  data-testid={`env-reconnect-${env.name}`}
                >
                  Reconnect
                </Button>
              )}
            {info.action === 'back_to_guided' && (
              <Button variant="primary" onClick={onBackToGuided} data-testid={`env-guided-${env.name}`}>
                <Wrench aria-hidden="true" className="size-4" />
                Back to guided
              </Button>
            )}
            {info.state === 'failed' && (
              <Button loading={deploy.isPending} onClick={doUpdate} data-testid={`env-retry-${env.name}`}>
                Try again
              </Button>
            )}
            {(canMove || moveOpen) && (
              <Button
                variant={moveOpen ? 'primary' : 'secondary'}
                onClick={() => setMoving(true)}
                data-testid={`env-move-${env.name}`}
              >
                <ArrowRightLeft aria-hidden="true" className="size-4" />
                {moveOpen ? 'Continue the move' : 'Move to a new server'}
              </Button>
            )}
            <span className="ml-auto" />
            <Menu label={`More for ${info.label}`}>
              <MenuItem onSelect={onEdit}>
                <Pencil aria-hidden="true" className="mr-1 inline size-4" />
                Edit
              </MenuItem>
              <MenuItem onSelect={onChangePlace}>
                {place?.kind === 'computer' ? 'Change computer' : 'Change server'}
              </MenuItem>
              {info.role === 'live' && info.strip.approved && (
                <MenuItem onSelect={() => setRollingBack(true)}>
                  <History aria-hidden="true" className="mr-1 inline size-4" />
                  Go back to an earlier version
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem danger onSelect={onRemove}>
                <Trash2 aria-hidden="true" className="mr-1 inline size-4" />
                Remove
              </MenuItem>
            </Menu>
          </div>
        ) : (
          <p className="text-xs text-subtle">Only the project owner changes environments.</p>
        )}
        {!s.canApprove && info.action === 'approve' && (
          <p className="text-xs text-subtle" data-testid={`env-waiting-owner-${env.name}`}>
            Waiting for the Owner's approval.
          </p>
        )}
        {s.canApprove && info.action === 'approve' && missingElsewhere.length > 0 && (
          <p className="text-xs text-subtle" data-testid={`env-approve-reason-${env.name}`}>
            Try {missingElsewhere.map(labelOf).join(' and ')} first: one approval covers all environments.
          </p>
        )}
        <ErrorBox error={dry.error ?? approve.error ?? deploy.error ?? check.error ?? probe.error} />
      </section>

      {approving && (
        <Dialog
          open
          onOpenChange={(o) => !o && setApproving(false)}
          title="Approve this version"
          description="The Owner approves exactly the version that was tried. Nothing runs from it before you do."
          footer={
            <>
              <Button variant="ghost" onClick={() => setApproving(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={approve.isPending}
                onClick={() =>
                  s.current.observedHash &&
                  approve.mutate(s.current.observedHash, {
                    onSuccess: () => {
                      toast.success('Approved');
                      setApproving(false);
                    },
                  })
                }
                data-testid="approve-confirm"
              >
                Approve
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-sm" data-testid="approve-dialog">
            <p className="text-fg">
              {(s.current.setup?.environments ?? []).map((e) => e.label).join(', ')} will use the steps that
              were tried.
            </p>
            {changesSinceApproval.length > 0 ? (
              <div>
                <p className="font-medium text-fg">What changed since the last approval</p>
                <ul className="mt-1 list-disc pl-5 text-muted">
                  {changesSinceApproval.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-muted">This is the first approval of these steps.</p>
            )}
            <details>
              <summary className="cursor-pointer text-xs text-subtle">Technical details</summary>
              <p className="mt-1 font-mono text-xs break-all text-muted">{s.current.observedHash}</p>
            </details>
            <ErrorBox error={approve.error} />
          </div>
        </Dialog>
      )}
      {releasing && (
        <ReleaseSheet
          projectId={projectId}
          env={env.name}
          label={info.label}
          onClose={() => setReleasing(false)}
        />
      )}
      {rollingBack && (
        <RollbackSheet
          projectId={projectId}
          env={env.name}
          label={info.label}
          onClose={() => setRollingBack(false)}
        />
      )}
      {moving && target && (
        <Dialog
          open
          onOpenChange={(o) => !o && setMoving(false)}
          title={`Move ${info.label} to a new server`}
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
      {editing && (
        <EnvironmentDialog
          projectId={projectId}
          state={s}
          editing={env}
          onClose={() => setEditing(false)}
          onAdvanced={() => {
            setEditing(false);
            onAdvanced();
          }}
        />
      )}
      {changing && (
        <ChangePlaceDialog
          projectId={projectId}
          s={s}
          env={env}
          label={info.label}
          onClose={() => setChanging(false)}
          onAddServer={() => setAddingServer(true)}
          moveBlocked={
            env.hosting === 'ssh' && !canMove
              ? nativeOf(env)
                ? 'An app that runs without Docker cannot be moved to another server with its data yet.'
                : !env.app.imageVar
                  ? 'Moving needs the app version to be set in the .env file on the server. Yours is named in an extra file next to the compose file, so it cannot be moved this way yet.'
                  : null
              : null
          }
          onMove={
            canMove
              ? () => {
                  setChanging(false);
                  setMoving(true);
                }
              : undefined
          }
        />
      )}
      {addingServer && (
        <AddServerDialog
          projectId={projectId}
          state={s}
          onClose={() => setAddingServer(false)}
          onAdded={() => setAddingServer(false)}
        />
      )}
      {removing && (
        <RemoveEnvironmentDialog
          projectId={projectId}
          label={info.label}
          env={env}
          place={place}
          last={(s.current.setup?.environments.length ?? 0) <= 1}
          onClose={() => setRemoving(false)}
        />
      )}
      {info.state === 'cannot_reach' && !canEdit && (
        <Callout tone="warning">Ask the project owner to reconnect it.</Callout>
      )}
    </li>
  );
}

export { agoText };

const portOf = (url: string | undefined) => /:(\d+)(\/|$)/.exec(url ?? '')?.[1] ?? '';
