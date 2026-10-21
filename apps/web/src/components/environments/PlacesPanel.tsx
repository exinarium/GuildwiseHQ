import { RETIRE_EXPLAINER, type SetupStateDto } from '@aom/shared';
import { Monitor, Plus, RefreshCw, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCheckTarget, useOp } from '../../api/queries/deploy-connect.ts';
import { useRetire } from '../../api/queries/deploy-move.ts';
import { useProbe } from '../../api/queries/deploy-setup.ts';
import { useForgetKey, useMergePlaces, useRemovePlace } from '../../api/queries/environments.ts';
import { ConnectServer } from '../delivery/connect/ConnectServer.tsx';
import { KeysList } from '../delivery/connect/KeysList.tsx';
import { needsReconnect, ReachabilityChip } from '../delivery/connect/ReachabilityChip.tsx';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  Disclosure,
  ErrorBox,
  Menu,
  MenuItem,
  useToast,
} from '../ui.tsx';
import { type PlaceVm, placesOf } from './model.ts';

/**
 * Places (docs/design/environments-ux.md section 3): the computers and servers this project uses, each listed once, with who
 * uses it, whether it can be reached, and the actions that belong to a place (check, reconnect, merge a duplicate, remove).
 */
export function PlacesPanel({
  projectId,
  s,
  places: given,
  onAddServer,
}: {
  projectId: string;
  s: SetupStateDto;
  /** The places the server lists; absent: derived from the setup state. */
  places?: PlaceVm[] | undefined;
  onAddServer: () => void;
}) {
  const places = given ?? placesOf(s);
  const active = places.filter((p) => p.role === 'active');
  const old = places.filter((p) => p.role !== 'active');
  const check = useCheckTarget(projectId);
  const probe = useProbe(projectId);
  const remove = useRemovePlace(projectId);
  const merge = useMergePlaces(projectId);
  const toast = useToast();
  const [removing, setRemoving] = useState<PlaceVm | null>(null);
  const [merging, setMerging] = useState<PlaceVm | null>(null);
  const [reconnect, setReconnect] = useState<PlaceVm | null>(null);
  const [alsoKey, setAlsoKey] = useState(false);
  const [cleanup, setCleanup] = useState<{ id: string; name: string } | null>(null);

  return (
    <div className="flex flex-col gap-3" data-testid="places-list">
      <ul className="flex flex-col gap-2">
        {active.map((p) => {
          const reach = p.reach
            ? { ...p.reach, method: 'existing_alias' as const, workstationId: p.workstationId ?? '' }
            : null;
          const target = s.targets.find((t) => t.id === p.id);
          return (
            <li
              key={p.id}
              className="flex flex-col gap-1.5 rounded-control border border-line p-3"
              data-testid={`place-${p.key}`}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {p.kind === 'server' ? (
                  <Server aria-hidden="true" className="size-4 text-muted" />
                ) : (
                  <Monitor aria-hidden="true" className="size-4 text-muted" />
                )}
                <span className="font-medium text-fg">{p.name}</span>
                <span className="text-sm text-muted">{p.what}</span>
                {p.kind === 'computer' && p.online !== null && (
                  <Badge tone={p.online ? 'green' : 'neutral'}>{p.online ? 'Online' : 'Offline'}</Badge>
                )}
                {p.kind === 'server' && <ReachabilityChip reachability={reach} />}
              </div>
              <p className="text-sm text-muted" data-testid={`place-used-${p.key}`}>
                {p.usedBy.length > 0
                  ? `Used by: ${p.usedBy.map((u) => u.label).join(', ')}`
                  : 'Used by: nothing'}
                {p.usedByDraft.length > 0 ? ` · in your unfinished changes: ${p.usedByDraft.join(', ')}` : ''}
                {p.key !== p.name && p.kind === 'computer' ? ` · called ${p.key}` : ''}
              </p>
              {p.duplicateOf && (
                <Callout tone="warning" data-testid={`place-duplicate-${p.key}`}>
                  <span>
                    Looks like a duplicate of {p.duplicateName} (
                    {p.kind === 'server' ? 'same address' : 'same computer'}).
                  </span>
                  {s.canEdit && (
                    <div className="mt-2">
                      <Button size="sm" onClick={() => setMerging(p)} data-testid={`place-merge-${p.key}`}>
                        Merge
                      </Button>
                    </div>
                  )}
                </Callout>
              )}
              {s.canEdit && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={(check.isPending && check.variables === p.id) || probe.isPending}
                    onClick={() =>
                      p.kind === 'server'
                        ? check.mutate(p.id, { onSuccess: () => toast.success('Checking the connection') })
                        : probe.mutate({
                            scope: 'local',
                            ...(p.workstationId ? { workstationId: p.workstationId } : {}),
                          })
                    }
                    data-testid={`place-check-${p.key}`}
                  >
                    <RefreshCw aria-hidden="true" className="size-4" />
                    Check
                  </Button>
                  {p.kind === 'server' && target && (
                    <Button
                      size="sm"
                      variant={needsReconnect(reach) ? 'primary' : 'ghost'}
                      onClick={() => setReconnect(p)}
                      data-testid={`place-reconnect-${p.key}`}
                    >
                      {needsReconnect(reach) ? 'Reconnect' : 'Use another computer'}
                    </Button>
                  )}
                  <span className="ml-auto" />
                  <Menu label={`More for ${p.name}`}>
                    <MenuItem danger onSelect={() => setRemoving(p)}>
                      Remove
                    </MenuItem>
                  </Menu>
                </div>
              )}
              {p.kind === 'server' && (target?.keys?.length ?? 0) > 0 && (
                <Disclosure
                  summary={`Guildwise keys on this server (${target?.keys?.filter((k) => k.state === 'active').length ?? 0})`}
                >
                  <KeysList
                    projectId={projectId}
                    targetId={p.id}
                    keys={target?.keys ?? []}
                    signInWorkstationId={
                      s.workstations.find((w) => w.id === p.workstationId && w.mine)?.id ?? null
                    }
                  />
                </Disclosure>
              )}
            </li>
          );
        })}
        {active.length === 0 && (
          <li className="text-sm text-subtle" data-testid="places-empty">
            No place yet. A place is added when you add an environment, or here.
          </li>
        )}
      </ul>
      {old.length > 0 && <OldServers projectId={projectId} s={s} old={old} />}
      <ErrorBox error={check.error ?? probe.error ?? remove.error ?? merge.error} />
      {s.canEdit && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={onAddServer} data-testid="places-add-server">
            <Plus aria-hidden="true" className="size-4" />
            Add a server
          </Button>
          <a
            href="/workstations"
            className="inline-flex h-9 items-center justify-center gap-1 rounded-control border border-control bg-surface px-3 text-sm font-medium text-fg hover:bg-sunken [@media(pointer:coarse)]:h-11"
            data-testid="places-add-computer"
          >
            <Plus aria-hidden="true" className="size-4" />
            Add a computer
          </a>
        </div>
      )}

      {removing && (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setRemoving(null);
              setAlsoKey(false);
            }
          }}
          title={`Remove ${removing.name} from this project?`}
          footer={
            <>
              <Button variant="ghost" autoFocus onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={!!blockedBy(removing)}
                loading={remove.isPending}
                data-testid="remove-place-confirm"
                onClick={() =>
                  remove.mutate(
                    { id: removing.id, ...(alsoKey ? { revokeKey: true } : {}) },
                    {
                      onSuccess: (r) => {
                        toast.success(`${removing.name} removed`);
                        if (r.keyCleanup.state === 'started' && r.keyCleanup.commandId)
                          setCleanup({ id: r.keyCleanup.commandId, name: removing.name });
                        else if (r.keyCleanup.state === 'skipped' && r.keyCleanup.reason)
                          toast.success(`The key was not removed: ${r.keyCleanup.reason}`);
                        setRemoving(null);
                        setAlsoKey(false);
                      },
                    },
                  )
                }
              >
                Remove
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-sm" data-testid="remove-place-dialog">
            {blockedBy(removing) ? (
              <Callout tone="warning" data-testid="place-in-use">
                {blockedBy(removing)} Open the environment, choose{' '}
                <strong>Change {removing.kind === 'server' ? 'server' : 'computer'}</strong>, then remove this
                place.
              </Callout>
            ) : (
              <p className="text-muted">
                Nothing {removing.kind === 'server' ? 'on the server' : 'on the computer'} is touched. Only
                the connection from this project to {removing.name} is removed.
              </p>
            )}
            {removing.kind === 'server' && !blockedBy(removing) && (
              <label className="flex min-h-11 items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 size-4"
                  checked={alsoKey}
                  onChange={(e) => setAlsoKey(e.target.checked)}
                  data-testid="remove-key"
                />
                <span>
                  Also remove Guildwise's sign-in key from the server
                  <span className="block text-xs text-subtle">
                    Only the key Guildwise added is taken off. Your own keys stay.
                  </span>
                </span>
              </label>
            )}
            <ErrorBox error={remove.error} />
          </div>
        </Dialog>
      )}
      {cleanup && (
        <KeyCleanup
          projectId={projectId}
          commandId={cleanup.id}
          name={cleanup.name}
          onClose={() => setCleanup(null)}
        />
      )}
      {merging && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setMerging(null)}
          title={`Merge ${merging.name} into ${merging.duplicateName}?`}
          confirmLabel="Merge"
          tone="primary"
          pending={merge.isPending}
          onConfirm={() =>
            merging.duplicateOf &&
            merge.mutate(
              { fromId: merging.id, toId: merging.duplicateOf },
              {
                onSuccess: () => {
                  toast.success('Merged. The setup changed, so it needs trying and approving again.');
                  setMerging(null);
                },
              },
            )
          }
        >
          <p className="text-sm text-muted" data-testid="merge-dialog">
            {merging.usedBy.length > 0
              ? `${merging.usedBy.map((u) => u.label).join(', ')} will use ${merging.duplicateName} instead. `
              : ''}
            Nothing on the {merging.kind === 'server' ? 'server' : 'computer'} is touched. Because the steps
            are written for a place, they are made again and need trying and approving again.
          </p>
        </ConfirmDialog>
      )}
      {reconnect && (
        <Dialog
          open
          onOpenChange={(o) => !o && setReconnect(null)}
          title={`Reconnect ${reconnect.name}`}
          size="lg"
        >
          <ConnectServer
            heading={false}
            projectId={projectId}
            target={{
              id: reconnect.id,
              name: reconnect.key,
              host: reconnect.host,
              workstationId: reconnect.workstationId,
              keys: reconnect.keys ?? [],
            }}
            onCancel={() => setReconnect(null)}
            onDone={() => {
              setReconnect(null);
              toast.success('Connected');
            }}
          />
        </Dialog>
      )}
    </div>
  );
}

/**
 * The old servers of finished moves: a standby is a fallback that nothing deploys to; the Owner can retire it, which only
 * removes the keys Guildwise added to it (nothing on the server is deleted, ever).
 */
function OldServers({ projectId, s, old }: { projectId: string; s: SetupStateDto; old: PlaceVm[] }) {
  const retire = useRetire(projectId);
  const [asking, setAsking] = useState<string | null>(null);
  const toast = useToast();
  const target = old.find((t) => t.id === asking);
  return (
    <section className="flex flex-col gap-2" data-testid="old-servers">
      <h3 className="text-sm font-semibold text-fg">Old servers</h3>
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
            {t.role === 'standby' &&
              (s.canApprove ? (
                <div>
                  <Button size="sm" onClick={() => setAsking(t.id)} data-testid={`retire-${t.id}`}>
                    Retire
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-subtle">Only the Owner retires a server.</p>
              ))}
          </li>
        ))}
      </ul>
      <ErrorBox error={retire.error} />
      {target && (
        <Dialog
          open
          onOpenChange={(o) => !o && setAsking(null)}
          title={`Retire ${target.name}?`}
          footer={
            <>
              <Button variant="ghost" autoFocus onClick={() => setAsking(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={retire.isPending}
                data-testid="retire-confirm"
                onClick={() =>
                  retire.mutate(target.id, {
                    onSuccess: () => {
                      setAsking(null);
                      toast.success('Removing the Guildwise keys from the old server');
                    },
                  })
                }
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
      )}
    </section>
  );
}

/** Why a place cannot be removed, in a sentence naming what uses it; null when it can. */
function blockedBy(p: PlaceVm): string | null {
  if (p.removeBlockedReason) return p.removeBlockedReason;
  if (p.canRemove === false) return 'Something still uses it: change that first.';
  const names = [...p.usedBy.map((u) => u.label), ...p.usedByDraft];
  return names.length > 0 ? `Used by ${names.join(', ')}: change that first.` : null;
}

/**
 * After a place was removed with "also remove Guildwise's key": follows the operation. If the server could not be asked to drop
 * the key, this computer kept its own key; the person may forget it anyway (the key on the server then stays there).
 */
function KeyCleanup({
  projectId,
  commandId,
  name,
  onClose,
}: {
  projectId: string;
  commandId: string;
  name: string;
  onClose: () => void;
}) {
  const op = useOp(projectId, commandId);
  const forget = useForgetKey(projectId);
  const toast = useToast();
  const d = op.data;
  const failed = d && d.state !== 'pending' && d.ok === false;
  const done = !!d && d.state === 'done' && !!d.ok;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the operation is done
  useEffect(() => {
    if (!done) return;
    toast.success(`Guildwise's key was taken off ${name}`);
    onClose();
  }, [done]);
  if (done) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`The key on ${name}`}>
      <div className="flex flex-col gap-3 text-sm" data-testid="key-cleanup" role="status">
        {!d || d.state === 'pending' ? (
          <p className="text-muted">Taking Guildwise's key off the server...</p>
        ) : (
          <>
            <Callout
              tone={failed ? 'danger' : 'info'}
              title={failed ? 'The key could not be removed from the server' : 'Done'}
            >
              {d.errorText ?? 'The server did not answer.'}
            </Callout>
            {d.localKeyKept && (
              <>
                <p className="text-muted">
                  This computer kept its own copy of the key, so you can try again. If you will never use this
                  server again, forget the key on this computer anyway. The key stays on the server until you
                  remove it there.
                </p>
                <div>
                  <Button
                    variant="danger"
                    loading={forget.isPending}
                    data-testid="forget-key-anyway"
                    onClick={() =>
                      forget.mutate(commandId, {
                        onSuccess: () => {
                          toast.success('The key was forgotten on this computer');
                          onClose();
                        },
                      })
                    }
                  >
                    Forget the key on this computer anyway
                  </Button>
                </div>
              </>
            )}
          </>
        )}
        <ErrorBox error={forget.error} />
      </div>
    </Dialog>
  );
}
