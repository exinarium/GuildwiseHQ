import type { ProjectDto } from '@aom/shared';
import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';
import { Link, matchPath, useLocation } from 'react-router';

interface Crumb {
  label: string;
  to?: string;
}

/** Crumbs for a route. Group names are plain text; the last crumb is the current page. */
export function crumbsFor(pathname: string, search: string, projects: ProjectDto[]): Crumb[] {
  const name = (k?: string) => projects.find((p) => p.key === k)?.name ?? k ?? '';
  const table: Array<[string, (p: Record<string, string | undefined>) => Crumb[]]> = [
    ['/p/:key/board', (p) => [{ label: name(p.key) }, { label: 'Board' }]],
    ['/p/:key/archive', (p) => [{ label: name(p.key), to: `/p/${p.key}/board` }, { label: 'Archive' }]],
    ['/p/:key/feed', (p) => [{ label: name(p.key), to: `/p/${p.key}/board` }, { label: 'Feed' }]],
    [
      '/p/:key/environments',
      (p) => [
        { label: 'Projects', to: '/projects' },
        { label: name(p.key), to: `/p/${p.key}/board` },
        { label: 'Environments' },
      ],
    ],
    [
      '/p/:key/phases/:number',
      (p) => [{ label: name(p.key), to: `/p/${p.key}/board` }, { label: `Phase ${p.number}` }],
    ],
    [
      '/cards/new',
      () => {
        const k = new URLSearchParams(search).get('project') ?? undefined;
        return [...(k ? [{ label: name(k), to: `/p/${k}/board` }] : []), { label: 'New card' }];
      },
    ],
    [
      '/cards/:ref',
      (p) => {
        const ref = p.ref ?? '';
        const key = ref.slice(0, Math.max(0, ref.lastIndexOf('-')));
        return [{ label: name(key), to: `/p/${key}/board` }, { label: ref }];
      },
    ],
    ['/projects', () => [{ label: 'Projects' }]],
    [
      '/projects/:id/settings',
      (p) => [
        { label: 'Projects', to: '/projects' },
        { label: projects.find((x) => x.id === p.id)?.key ?? 'Project' },
        { label: 'Settings' },
      ],
    ],
    ['/agents', () => [{ label: 'Organization' }, { label: 'Agents' }]],
    ['/hr', () => [{ label: 'Organization' }, { label: 'Agents' }]],
    ['/org/ceo', () => [{ label: 'Organization' }, { label: 'CEO' }]],
    ['/org', () => [{ label: 'Organization' }, { label: 'Roles & workflows' }]],
    [
      '/org/workflows/:draftId',
      () => [
        { label: 'Organization' },
        { label: 'Roles & workflows', to: '/org?tab=workflows' },
        { label: 'Workflow builder' },
      ],
    ],
    [
      '/workstations/:id/integrations',
      () => [
        { label: 'Organization' },
        { label: 'Workstations', to: '/workstations' },
        { label: 'Integrations' },
      ],
    ],
    ['/integrations', () => [{ label: 'Organization' }, { label: 'Integrations' }]],
    ['/workstations', () => [{ label: 'Organization' }, { label: 'Workstations' }]],
    ['/releases', () => [{ label: 'Organization' }, { label: 'Releases' }]],
    ['/metrics', () => [{ label: 'Organization' }, { label: 'Metrics' }]],
    ['/ledger', () => [{ label: 'Knowledge' }, { label: 'Ledger' }]],
    ['/interests', () => [{ label: 'Knowledge' }, { label: 'Interests' }]],
    ['/settings/vaults', () => [{ label: 'Knowledge' }, { label: 'Vaults' }]],
    ['/settings', () => [{ label: 'Settings' }]],
    ['/help/contact', () => [{ label: 'Help', to: '/help' }, { label: 'Contact us' }]],
    [
      '/help/requests/:id',
      () => [
        { label: 'Help', to: '/help' },
        { label: 'My requests', to: '/help/requests' },
        { label: 'Request' },
      ],
    ],
    ['/help/requests', () => [{ label: 'Help', to: '/help' }, { label: 'My requests' }]],
    ['/help', () => [{ label: 'Help' }]],
    ['/intake/:id', () => [{ label: 'Intake', to: '/intake' }, { label: 'Conversation' }]],
    ['/intake', () => [{ label: 'Work' }, { label: 'Intake' }]],
    ['/ceo-chat', () => [{ label: 'Desk', to: '/desk' }, { label: 'CEO chat' }]],
    ['/ceo-chat/:threadId', () => [{ label: 'Desk', to: '/desk' }, { label: 'CEO chat' }]],
    ['/chat/:threadId', () => [{ label: 'Desk', to: '/desk' }, { label: 'Chat' }]],
    ['/desk', () => [{ label: 'Desk' }]],
    ['/automations', () => [{ label: 'Work' }, { label: 'Automations' }]],
    ['/settings/org', () => [{ label: 'Settings', to: '/settings' }, { label: 'Organization' }]],
  ];
  for (const [pattern, build] of table) {
    const m = matchPath(pattern, pathname);
    if (m) return build(m.params);
  }
  return [];
}

export function Breadcrumbs({ projects }: { projects: ProjectDto[] }) {
  const { pathname, search } = useLocation();
  const crumbs = crumbsFor(pathname, search, projects);
  if (crumbs.length === 0) return <div />;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1 text-sm text-muted">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <Fragment key={`${c.to ?? '-'}|${c.label}`}>
              {i > 0 && <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-subtle" />}
              <li className="min-w-0">
                {c.to && !last ? (
                  <Link
                    to={c.to}
                    className="block max-w-[12rem] truncate rounded hover:text-fg hover:underline"
                  >
                    {c.label}
                  </Link>
                ) : (
                  <span
                    aria-current={last ? 'page' : undefined}
                    className={`block max-w-[16rem] truncate ${last ? 'font-medium text-fg' : ''}`}
                  >
                    {c.label}
                  </span>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
