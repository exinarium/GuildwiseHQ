import { effectiveView } from '@aom/shared';
import { Eye } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useMe } from '../api/queries/auth.ts';
import { useSetMyView } from '../api/queries/orgs.ts';
import { EmptyState } from './ui/EmptyState.tsx';
import { Skeleton } from './ui/Skeleton.tsx';
import { Button } from './ui.tsx';

/**
 * A page that belongs to the Software view (test environments, releases). In the Business view it shows a gentle
 * note with a one-click way to the Software view instead of the page. Nothing is blocked: the page, its data and its
 * server routes all work in every view.
 */
export function DevOnly({ children }: { children: ReactNode }) {
  const me = useMe();
  const setView = useSetMyView();
  if (me.isLoading) return <Skeleton className="m-6 h-40" />;
  const org = me.data?.activeOrg;
  if (effectiveView(org) !== 'business') return <>{children}</>;
  return (
    <EmptyState
      icon={Eye}
      tone="neutral"
      title="Switch to Software view to see this"
      description="This page is part of the Software view, which the Business view tucks away. Nothing is lost or switched off: your projects keep running, and you can switch views at any time."
      data-testid="not-available-business"
      action={
        <Button
          onClick={() => setView.mutate('dev')}
          disabled={setView.isPending}
          data-testid="switch-to-software-view"
        >
          Switch to Software view
        </Button>
      }
      secondaryAction={
        <Link to="/projects" className="text-sm font-medium underline">
          Back to projects
        </Link>
      }
    />
  );
}
