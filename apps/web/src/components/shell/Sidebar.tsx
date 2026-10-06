import type { ProjectDto, UserAvatar as UserAvatarValue } from '@aom/shared';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ChevronsLeft, ChevronsRight, LogOut, Plus } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { Logo, LogoMark } from '../Logo.tsx';
import { cx } from '../ui/cx.ts';
import { isActive, type NavEntry, type NavSection } from './nav-config.ts';
import { ProjectSwitcher } from './ProjectSwitcher.tsx';
import { UserMenu } from './UserMenu.tsx';

export interface DeskCounts {
  open: number;
  blocking: number;
}

function DeskPill({ counts, collapsed }: { counts: DeskCounts; collapsed: boolean }) {
  if (counts.open <= 0) return null;
  const blocking = counts.blocking > 0;
  return (
    <span
      data-testid="desk-badge"
      title={`${counts.blocking} blocking, ${counts.open} open`}
      className={cx(
        'tnum inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold',
        blocking ? 'bg-danger-solid text-white' : 'bg-accent text-accent-fg',
        collapsed && 'absolute -top-1.5 -right-1.5 h-[18px] min-w-[18px] px-1 text-xs',
      )}
    >
      {counts.open}
    </span>
  );
}

function Item({
  entry,
  collapsed,
  counts,
  onNavigate,
}: {
  entry: NavEntry;
  collapsed: boolean;
  counts: DeskCounts;
  onNavigate?: (() => void) | undefined;
}) {
  const { pathname } = useLocation();
  const active = isActive(entry, pathname);
  const link = (
    <Link
      to={entry.to}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      {...(entry.testId ? { 'data-testid': entry.testId } : {})}
      className={cx(
        'group relative flex items-center gap-3 rounded-control text-[14px] font-medium transition-colors duration-100',
        collapsed ? 'size-10 justify-center' : 'min-h-9 px-3 py-1.5 [@media(pointer:coarse)]:min-h-11',
        active
          ? 'bg-side-active text-side-strong'
          : 'text-side-fg hover:bg-side-hover hover:text-side-strong',
      )}
    >
      {active && (
        <span aria-hidden="true" className="absolute top-2 bottom-2 -left-2 w-[3px] rounded-r bg-accent" />
      )}
      <entry.icon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
      <span className={collapsed ? 'sr-only' : 'flex-1 truncate'}>{entry.label}</span>
      {entry.id === 'desk' && <DeskPill counts={counts} collapsed={collapsed} />}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{link}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="right"
          sideOffset={10}
          className="z-90 rounded-control bg-fg px-2.5 py-1.5 text-xs font-medium text-canvas shadow-md"
        >
          {entry.label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** The navigation column: logo, project switcher, New card, grouped links, account. Used by sidebar and drawer. */
export function SidebarBody({
  sections,
  footer,
  collapsed = false,
  counts,
  project,
  projects,
  user,
  onSignOut,
  onNavigate,
  headerSlot,
  orgSlot,
}: {
  sections: NavSection[];
  footer: NavEntry[];
  collapsed?: boolean;
  counts: DeskCounts;
  project: ProjectDto | null;
  projects: ProjectDto[];
  user: { id?: string; name: string; email: string; roleLabel: string; avatar?: UserAvatarValue | null };
  onSignOut: () => void;
  onNavigate?: () => void;
  headerSlot?: React.ReactNode;
  /** The organization switcher, above the project switcher. */
  orgSlot?: React.ReactNode;
}) {
  return (
    <div className="on-side flex h-full min-h-0 flex-col text-side-fg">
      <div
        className={cx(
          'flex h-14 shrink-0 items-center',
          collapsed ? 'justify-center' : 'justify-between px-4',
        )}
      >
        {collapsed ? <LogoMark size={32} /> : <Logo variant="dark" height={28} />}
        {headerSlot}
      </div>
      <div className={cx('space-y-2 pb-2', collapsed ? 'px-3' : 'px-3')}>
        {orgSlot && <div className="border-b border-side-line pb-2">{orgSlot}</div>}
        <ProjectSwitcher
          current={project}
          projects={projects}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
        <Link
          to={project ? `/cards/new?project=${project.key}` : '/cards/new'}
          onClick={onNavigate}
          aria-label="New card"
          className={cx(
            'flex items-center justify-center gap-2 rounded-control bg-accent font-semibold text-accent-fg hover:brightness-95',
            collapsed ? 'size-10' : 'h-10 w-full text-sm [@media(pointer:coarse)]:h-11',
          )}
        >
          <Plus aria-hidden="true" className="size-4" strokeWidth={2.5} />
          {!collapsed && <span>New card</span>}
        </Link>
      </div>
      <nav
        aria-label="Main"
        className={cx('min-h-0 flex-1 overflow-y-auto pb-3', collapsed ? 'px-3' : 'px-3')}
      >
        {sections.map((s, i) => (
          <div
            key={s.label}
            className={cx(i > 0 && (collapsed ? 'mt-3 border-t border-side-line pt-3' : 'mt-3'))}
          >
            {collapsed ? (
              <h2 className="sr-only">{s.label}</h2>
            ) : (
              <h2 className="px-3 pt-1 pb-1.5 text-xs font-semibold tracking-wider text-side-label uppercase">
                {s.label}
              </h2>
            )}
            <ul className={cx('space-y-0.5', collapsed && 'flex flex-col items-center')}>
              {s.items.map((e) => (
                <li key={e.id} className="relative">
                  <Item entry={e} collapsed={collapsed} counts={counts} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="shrink-0 space-y-1 border-t border-side-line p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <ul className={cx('space-y-0.5', collapsed && 'flex flex-col items-center')}>
          {footer.map((e) => (
            <li key={e.id} className="relative">
              <Item entry={e} collapsed={collapsed} counts={counts} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
        <div className={cx('flex items-center gap-1', collapsed && 'flex-col')}>
          <div className="min-w-0 flex-1">
            <UserMenu
              name={user.name}
              {...(user.id ? { userId: user.id } : {})}
              avatar={user.avatar ?? null}
              email={user.email}
              roleLabel={user.roleLabel}
              collapsed={collapsed}
              onSignOut={onSignOut}
              {...(onNavigate ? { onNavigate } : {})}
            />
          </div>
          <button
            type="button"
            onClick={onSignOut}
            {...(collapsed ? { 'aria-label': 'Sign out', title: 'Sign out' } : {})}
            className={cx(
              'flex items-center justify-center gap-2 rounded-control border border-side-line text-sm font-medium text-side-fg hover:bg-side-hover hover:text-side-strong',
              collapsed ? 'mx-auto size-10' : 'h-9 shrink-0 px-2.5 [@media(pointer:coarse)]:h-11',
            )}
          >
            <LogOut aria-hidden="true" className="size-4" />
            {!collapsed && 'Sign out'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CollapseButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? ChevronsRight : ChevronsLeft;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
      className="inline-flex size-8 items-center justify-center rounded-control text-side-label hover:bg-side-hover hover:text-side-strong"
    >
      <Icon aria-hidden="true" className="size-4" />
    </button>
  );
}
