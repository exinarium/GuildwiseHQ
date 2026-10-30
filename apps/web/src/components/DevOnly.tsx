import { isBusinessOrg } from '@aom/shared';
import { Ban } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useMe } from '../api/queries/auth.ts';
import { EmptyState } from './ui/EmptyState.tsx';
import { Skeleton } from './ui/Skeleton.tsx';

/** A page for software delivery: in a Business mode organization it shows "not available" instead. */
export function DevOnly({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isLoading) return <Skeleton className="m-6 h-40" />;
  const org = me.data?.activeOrg;
  if (!isBusinessOrg(org)) return <>{children}</>;
  const manager = org?.role === 'owner' || org?.role === 'admin';
  return (
    <EmptyState
      icon={Ban}
      tone="neutral"
      title="Not available in Business mode"
      description="This page is for software delivery. An Owner or Admin can switch the organization to Developer mode in Organization settings."
      data-testid="not-available-business"
      action={
        <Link to="/projects" className="text-sm font-medium underline">
          Back to projects
        </Link>
      }
      secondaryAction={
        manager ? (
          <Link to="/settings/org" className="text-sm font-medium underline">
            Organization settings
          </Link>
        ) : undefined
      }
    />
  );
}
