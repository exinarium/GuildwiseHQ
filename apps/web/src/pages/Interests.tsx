import type { InterestDto } from '@aom/shared';
import { Lightbulb } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useInterests } from '../api/queries/interests.ts';
import { InterestCard } from '../components/interests/InterestCard.tsx';
import { NewInterestDialog } from '../components/interests/NewInterestDialog.tsx';
import { QuietCapPanel } from '../components/interests/QuietCapPanel.tsx';
import { ResearchThisDialog } from '../components/interests/ResearchThisDialog.tsx';
import {
  Button,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Select,
  TextInput,
} from '../components/ui.tsx';

/**
 * What you follow (docs/design/restructure.md section 7.2). Each interest scans on its own schedule, delivers its
 * results at the times you choose, and learns from your ratings. It lives under Knowledge; the project behind it stays hidden.
 */
export function Interests() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const [status, setStatus] = useState<'' | 'active' | 'paused'>('');
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState('');
  const list = useInterests({ status: status || undefined, archived });
  const [creating, setCreating] = useState(false);
  const [researching, setResearching] = useState<InterestDto | null>(null);

  // Deep links from the earlier layout: /interests?open=<id> opens the interest.
  const openId = params.get('open');
  useEffect(() => {
    if (!openId) return;
    const next = new URLSearchParams(params);
    next.delete('open');
    setParams(next, { replace: true });
    nav(`/interests/${openId}${params.get('tab') ? `?tab=${params.get('tab')}` : ''}`, { replace: true });
  }, [openId, params, setParams, nav]);

  const needle = search.trim().toLowerCase();
  const shown = (list.data?.interests ?? []).filter(
    (i) => !needle || i.name.toLowerCase().includes(needle) || i.description.toLowerCase().includes(needle),
  );

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-3">
      <PageHeader
        title="Interests"
        sub="What you follow. Each interest scans on its own schedule and learns from your ratings."
        actions={
          <Button
            variant="primary"
            className="min-h-11 sm:min-h-8"
            data-testid="interest-new"
            onClick={() => setCreating(true)}
          >
            + New interest
          </Button>
        }
      />
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-32">
          <Select
            label="Status"
            value={status}
            data-testid="interests-status-filter"
            onChange={(e) => setStatus(e.target.value as '' | 'active' | 'paused')}
          >
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </Select>
        </div>
        <div className="min-w-40 flex-1">
          <TextInput
            label="Search"
            value={search}
            data-testid="interests-search"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="flex min-h-9 items-center gap-2 pb-1 text-sm [@media(pointer:coarse)]:min-h-11">
          <input
            type="checkbox"
            checked={archived}
            data-testid="interests-archived"
            onChange={(e) => setArchived(e.target.checked)}
          />
          Show archived
        </label>
      </div>

      {list.isPending && <ListSkeleton label="Loading interests" rows={3} />}
      <ErrorBox error={list.error} onRetry={() => list.refetch()} />
      <ul className="flex flex-col gap-3" aria-label="Interests" data-testid="interests">
        {shown.map((i) => (
          <li key={i.id} data-testid={`interest-${i.name}`}>
            <InterestCard interest={i} onResearch={() => setResearching(i)} />
          </li>
        ))}
      </ul>
      {list.data && shown.length === 0 && (
        <EmptyState
          data-testid="interests-empty"
          icon={Lightbulb}
          title={archived ? 'No archived interests' : 'No interests yet'}
          description="An interest is something you follow: a topic scanned on a schedule, delivered as a digest at the times you choose, rated by you, with its own taste rules."
          action={
            archived ? undefined : (
              <Button variant="primary" onClick={() => setCreating(true)}>
                + New interest
              </Button>
            )
          }
        />
      )}

      {list.data && (
        <QuietCapPanel
          cap={list.data.quietCap}
          deliveredToday={list.data.deliveredToday}
          canEdit={list.data.canSetCap}
        />
      )}

      {creating && <NewInterestDialog onClose={() => setCreating(false)} />}
      {researching && <ResearchThisDialog interest={researching} onClose={() => setResearching(null)} />}
    </div>
  );
}
