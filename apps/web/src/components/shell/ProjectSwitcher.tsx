import type { ProjectDto } from '@aom/shared';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, matchPath, useLocation, useNavigate } from 'react-router';
import { departmentsOf, inDepartment } from '../../lib/designer.ts';
import { setLastProjectKey } from '../../lib/lastProject.ts';
import { cx } from '../ui/cx.ts';
import { useToast } from '../ui/Toast.tsx';

const TYPE_LABEL: Record<string, string> = { code: 'Code', research: 'Research', feed: 'Feed' };
export const projectTypeLabel = (workflowKey: string) => TYPE_LABEL[workflowKey] ?? workflowKey;

export function KeyChip({ children, className }: { children: string; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex h-6 min-w-9 shrink-0 items-center justify-center rounded-[6px] bg-side-hover px-1.5 font-mono text-xs font-semibold tracking-tight text-side-strong',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The current project and the way to change it. Lives at the top of the sidebar and the mobile drawer. */
export function ProjectSwitcher({
  current,
  projects,
  collapsed = false,
  onNavigate,
}: {
  current: ProjectDto | null;
  projects: ProjectDto[];
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const { pathname } = useLocation();
  const toast = useToast();
  const departments = departmentsOf(projects);
  const filtered = projects.filter((p) =>
    `${p.key} ${p.name}`.toLowerCase().includes(q.trim().toLowerCase()),
  );

  const pick = (p: ProjectDto) => {
    setOpen(false);
    setQ('');
    setLastProjectKey(p.key);
    const on = matchPath('/p/:key/:page', pathname);
    if (on && (on.params.page === 'board' || on.params.page === 'feed')) {
      nav(`/p/${p.key}/${p.workflowKey === 'feed' && on.params.page === 'feed' ? 'feed' : 'board'}`);
    } else if (p.key !== current?.key) {
      toast.info(`Now working in ${p.name}`);
      nav(`/p/${p.key}/board`);
    }
    onNavigate?.();
  };

  const group = (label: string | null, list: ProjectDto[]) =>
    list.length === 0 ? null : (
      <div key={label ?? 'all'} className="py-1">
        {label && <p className="px-3 pt-1 pb-0.5 text-xs font-medium text-subtle">{label}</p>}
        <ul>
          {list.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => pick(p)}
                aria-current={p.key === current?.key ? 'true' : undefined}
                className="flex min-h-10 w-full items-center gap-2.5 rounded-[6px] px-3 py-1.5 text-left hover:bg-sunken data-[current=true]:bg-sunken [@media(pointer:coarse)]:min-h-12"
                data-current={p.key === current?.key}
              >
                <span className="inline-flex h-6 min-w-9 shrink-0 items-center justify-center rounded-[6px] bg-neutral-soft px-1.5 font-mono text-xs font-semibold text-neutral-soft-fg">
                  {p.key}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">{p.name}</span>
                  <span className="block text-xs text-subtle">
                    {projectTypeLabel(p.workflowKey)}
                    {p.myRole === 'manager' ? ' · shared with you' : ''}
                  </span>
                </span>
                {p.key === current?.key && (
                  <Check aria-hidden="true" className="size-4 shrink-0 text-brand-text" />
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        title="Switch project"
        aria-haspopup="listbox"
        className={cx(
          'flex w-full items-center gap-2.5 rounded-control border border-side-line bg-side-hover text-left text-side-strong hover:bg-side-active',
          collapsed ? 'h-10 justify-center px-1' : 'h-11 px-2.5',
        )}
      >
        {current ? <KeyChip>{current.key}</KeyChip> : <span className="text-sm">No project</span>}
        {!collapsed && current && (
          <>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{current.name}</span>
            <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-side-label" />
          </>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={collapsed ? 'right' : 'bottom'}
          align="start"
          sideOffset={8}
          className="z-90 w-[min(20rem,92vw)] animate-fade rounded-card border border-line bg-surface shadow-lg"
        >
          {projects.length > 6 && (
            <div className="relative border-b border-line p-2">
              <Search
                aria-hidden="true"
                className="absolute top-1/2 left-4.5 size-4 -translate-y-1/2 text-subtle"
              />
              <input
                type="search"
                aria-label="Find a project"
                placeholder="Find a project"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="h-9 w-full rounded-control border border-control bg-surface pr-3 pl-8 text-base text-fg placeholder:text-subtle"
              />
            </div>
          )}
          <div className="max-h-[60dvh] overflow-y-auto p-1">
            {departments.length > 0
              ? [
                  ...departments.map((d) => group(d, inDepartment(filtered, d))),
                  group(
                    'No department',
                    filtered.filter((p) => !p.department),
                  ),
                ]
              : group(null, filtered)}
            {filtered.length === 0 && (
              <p className="px-3 py-4 text-center text-sm text-subtle">No project matches.</p>
            )}
          </div>
          <div className="border-t border-line p-1">
            <Link
              to="/projects"
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
              className="flex min-h-9 items-center rounded-[6px] px-3 text-sm font-medium text-brand-text hover:bg-sunken"
            >
              See all
            </Link>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
