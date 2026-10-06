import type { MeResponse } from '@aom/shared';
import { ORG_ROLE_LABEL } from '@aom/shared';
import * as Popover from '@radix-ui/react-popover';
import { Building2, Check, ChevronsUpDown, Mail, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useSwitchOrg } from '../../api/queries/auth.ts';
import { hueFor, initials } from '../../lib/avatar.ts';
import { cx } from '../ui/cx.ts';
import { useToast } from '../ui/Toast.tsx';

/** A square mark for an organization: its initials on a stable hue (the design system has no org logos). */
export function OrgMark({ name, size = 28, className }: { name: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.4)),
        backgroundColor: `hsl(${hueFor(name)} 38% 34%)`,
      }}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-[8px] font-semibold text-white select-none',
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

/**
 * The organization of this tab, at the top of the sidebar (docs/design/organizations.md section 11.1). With one
 * organization and no guest access it is a plain label; otherwise it opens the list of the user's organizations
 * (suspended ones dimmed), the organizations they are a guest in, and a link to pending invitations.
 */
export function OrgSwitcher({
  me,
  collapsed = false,
  onNavigate,
}: {
  me: MeResponse;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const switchOrg = useSwitchOrg();
  const toast = useToast();
  const nav = useNavigate();
  const active = me.activeOrg;
  if (!active) return null;
  const single = me.orgs.length <= 1 && me.guestIn.length === 0 && me.pendingInvitations === 0;
  const roleLabel = ORG_ROLE_LABEL[active.role];

  const trigger = (
    <span
      className={cx(
        'flex w-full items-center gap-2.5 rounded-control text-left text-side-strong',
        collapsed ? 'h-10 justify-center' : 'min-h-11 px-2',
      )}
    >
      <OrgMark name={active.name} size={collapsed ? 28 : 30} />
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{active.name}</span>
            <span className="block text-xs text-side-label" data-testid="org-role">
              {roleLabel}
              {active.status !== 'active' && active.status !== 'trial' ? ` · ${active.status}` : ''}
            </span>
          </span>
          {!single && <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-side-label" />}
        </>
      )}
    </span>
  );
  if (single)
    return (
      <div data-testid="org-label" title={`${active.name} (${roleLabel})`}>
        {trigger}
      </div>
    );

  const pick = (id: string, name: string) => {
    if (id === active.id) return setOpen(false);
    setOpen(false);
    switchOrg.mutate(id, {
      onSuccess: () => {
        toast.info(`Now working in ${name}`);
        nav('/');
        onNavigate?.();
      },
    });
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        data-testid="org-switcher"
        aria-label={`Organization: ${active.name}. Switch organization`}
        className="block w-full rounded-control hover:bg-side-hover"
      >
        {trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={collapsed ? 'right' : 'bottom'}
          align="start"
          sideOffset={8}
          className="z-90 w-[min(20rem,92vw)] animate-fade rounded-card border border-line bg-surface shadow-lg"
        >
          <p className="px-4 pt-3 pb-1 text-xs font-semibold tracking-wider text-subtle uppercase">
            Your organizations
          </p>
          <ul className="p-1" aria-label="Your organizations">
            {me.orgs.map((o) => {
              const suspended = o.status === 'suspended' || o.status === 'cancelled';
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => pick(o.id, o.name)}
                    aria-current={o.id === active.id ? 'true' : undefined}
                    className={cx(
                      'flex min-h-11 w-full items-center gap-2.5 rounded-[6px] px-3 py-1.5 text-left hover:bg-sunken',
                      o.id === active.id && 'bg-sunken',
                      suspended && 'opacity-70',
                    )}
                  >
                    <OrgMark name={o.name} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">{o.name}</span>
                      <span className="block text-xs text-subtle">
                        {ORG_ROLE_LABEL[o.role]}
                        {suspended ? ` · ${o.status}` : ''}
                      </span>
                    </span>
                    {o.id === active.id && (
                      <Check aria-hidden="true" className="size-4 shrink-0 text-brand-text" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {me.guestIn.length > 0 && (
            <>
              <p className="px-4 pt-2 pb-1 text-xs font-semibold tracking-wider text-subtle uppercase">
                Guest in
              </p>
              <ul className="p-1" aria-label="Guest in">
                {me.guestIn.map((g) => (
                  <li key={g.orgId} className="flex items-center gap-2.5 px-3 py-1.5">
                    <Building2 aria-hidden="true" className="size-4 shrink-0 text-subtle" />
                    <span className="min-w-0 flex-1 text-sm text-fg">
                      <span className="font-medium">{g.orgName}</span>
                      <span className="block truncate text-xs text-subtle">
                        {g.projects.map((p) => p.key).join(', ')}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="border-t border-line p-1">
            {me.pendingInvitations > 0 && (
              <Link
                to="/projects"
                onClick={() => {
                  setOpen(false);
                  onNavigate?.();
                }}
                className="flex min-h-9 items-center gap-2 rounded-[6px] px-3 text-sm font-medium text-brand-text hover:bg-sunken"
              >
                <Mail aria-hidden="true" className="size-4" />
                {me.pendingInvitations} pending invitation{me.pendingInvitations === 1 ? '' : 's'}
              </Link>
            )}
            <Link
              to="/settings/org"
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
              className="flex min-h-9 items-center gap-2 rounded-[6px] px-3 text-sm font-medium text-fg hover:bg-sunken"
            >
              <Settings2 aria-hidden="true" className="size-4 text-muted" />
              Organization settings
            </Link>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
