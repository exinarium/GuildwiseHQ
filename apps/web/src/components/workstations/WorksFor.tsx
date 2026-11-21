import type { WorkstationDto, WorkstationOrgServing } from '@aom/shared';
import { useState } from 'react';
import { useMe } from '../../api/queries/auth.ts';
import { useSetWorkstationServing, useWorkstationServing } from '../../api/queries/workstations.ts';
import { Callout, ConfirmDialog, ErrorBox, useToast } from '../ui.tsx';

const ROLE = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const;

/**
 * "Works for" (R9, audit F4): the organizations this workstation runs work for. It works for the organizations you own
 * until you switch others on; joining an organization never does. Shown to the workstation's owner only. Switching one
 * off sends that organization's agents here to "needs a new home" and retires its DevOps engineer here.
 */
export function WorksFor({ w }: { w: WorkstationDto }) {
  const me = useMe();
  const mine = !!me.data && w.userId === me.data.user.id;
  const q = useWorkstationServing({ enabled: mine });
  const set = useSetWorkstationServing();
  const toast = useToast();
  const [confirmOff, setConfirmOff] = useState<WorkstationOrgServing | null>(null);
  if (!mine) return null;
  const orgs = q.data?.find((x) => x.workstationId === w.id)?.orgs ?? [];
  if (orgs.length === 0) return null;
  const change = (o: WorkstationOrgServing, serving: boolean) =>
    set.mutate(
      { workstationId: w.id, orgId: o.orgId, serving },
      {
        onSuccess: () => {
          setConfirmOff(null);
          toast.success(
            serving ? `${w.name} now works for ${o.orgName}` : `${w.name} no longer works for ${o.orgName}`,
          );
        },
      },
    );
  const notYet = orgs.filter((o) => !o.serving);
  return (
    <div className="mt-4 border-t border-line pt-3 text-sm" data-testid="works-for">
      <p className="mb-1 text-xs font-medium text-subtle">Works for</p>
      <p className="mb-2 text-muted">
        The organizations whose agents and DevOps work may run on {w.name}. Nobody else can switch this on for
        you.
      </p>
      <ul className="flex flex-col gap-2">
        {orgs.map((o) => (
          <li key={o.orgId} className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 text-fg">
              {o.orgName}
              <span className="ml-2 text-xs text-subtle">{o.role ? ROLE[o.role] : 'Guest'}</span>
            </span>
            <label className="flex min-h-11 items-center gap-2.5 font-medium text-fg sm:min-h-0">
              <input
                type="checkbox"
                role="switch"
                aria-checked={o.serving}
                aria-label={`${w.name} works for ${o.orgName}`}
                data-testid={`works-for-${o.orgId}`}
                className="size-5"
                checked={o.serving}
                disabled={set.isPending}
                onChange={(e) => (e.target.checked ? change(o, true) : setConfirmOff(o))}
              />
              {o.serving ? 'On' : 'Off'}
            </label>
          </li>
        ))}
      </ul>
      {notYet.length > 0 && (
        <Callout tone="info" role="status" className="mt-3" data-testid="works-for-notice">
          {w.name} does not work for {notYet.map((o) => o.orgName).join(', ')} yet: their agents cannot be
          placed here and no DevOps engineer of theirs runs here until you switch them on.
        </Callout>
      )}
      <ErrorBox error={set.error} />
      <ConfirmDialog
        open={!!confirmOff}
        onOpenChange={(open) => !open && setConfirmOff(null)}
        title={confirmOff ? `Stop working for ${confirmOff.orgName} on ${w.name}?` : ''}
        description="Its agents on this workstation wait for a new home and its DevOps engineer here is retired."
        confirmLabel="Switch off"
        pending={set.isPending}
        onConfirm={() => confirmOff && change(confirmOff, false)}
      >
        <ErrorBox error={set.error} />
      </ConfirmDialog>
    </div>
  );
}

/** Page notice: none of your workstations works for the organization you are looking at (R9). */
export function NotServedNotice({ workstations }: { workstations: WorkstationDto[] }) {
  const me = useMe();
  const org = me.data?.activeOrg;
  const mine = workstations.filter((w) => !!me.data && w.userId === me.data.user.id);
  const q = useWorkstationServing({ enabled: mine.length > 0 && !!org });
  if (!org || mine.length === 0 || !q.data) return null;
  const relevant = q.data.filter((x) => mine.some((w) => w.id === x.workstationId));
  const listed = relevant.some((x) => x.orgs.some((o) => o.orgId === org.id));
  const served = relevant.some((x) => x.orgs.some((o) => o.orgId === org.id && o.serving));
  if (!listed || served) return null;
  return (
    <Callout
      tone="info"
      role="status"
      className="mb-4"
      data-testid="not-served-notice"
      title={`Not working for ${org.name} yet`}
    >
      None of your workstations works for {org.name}. Switch it on under Works for on a workstation below to
      let its agents and DevOps engineer run there.
    </Callout>
  );
}
