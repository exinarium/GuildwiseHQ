import type { InterestDetailResponse } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useShareInterest, useUnshareInterest } from '../../api/queries/interests.ts';
import { useOrgMembers } from '../../api/queries/orgs.ts';
import {
  describeDelivery,
  describeRatings,
  describeScan,
  RUN_STATUS_LABEL,
  runStatusTone,
} from '../../lib/interests.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Button, ErrorBox, Panel, Select } from '../ui.tsx';

const Row = ({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) => (
  <div className="grid gap-0.5 sm:grid-cols-[11rem_1fr] sm:gap-3" data-testid={testId}>
    <dt className="text-sm text-subtle">{label}</dt>
    <dd className="text-sm text-fg">{children}</dd>
  </div>
);

/** What the interest is doing now: schedules, the last run, what waits for delivery, notes and who can see it. */
export function OverviewTab({ detail }: { detail: InterestDetailResponse }) {
  const i = detail.interest;
  const s = i.stats;
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="overview-tab">
      <Panel title="Schedules">
        <dl className="flex flex-col gap-2">
          <Row label="Runs" testId="overview-scan">
            {describeScan(i.scan)}
          </Row>
          <Row label="Next run">{s.nextScanAt ? formatDateTime(s.nextScanAt) : 'not scheduled'}</Row>
          <Row label="Delivery" testId="overview-delivery">
            {describeDelivery(i.delivery)}
          </Row>
          {i.delivery.mode === 'scheduled' && (
            <Row label="Next delivery">
              {s.nextDeliveryAt ? formatDateTime(s.nextDeliveryAt) : 'not scheduled'}
            </Row>
          )}
          <Row label="Waiting for delivery" testId="overview-held">
            {s.items.held} {s.items.held === 1 ? 'item' : 'items'}
          </Row>
          <Row label="Last delivered">{s.lastDeliveredAt ? formatDateTime(s.lastDeliveredAt) : 'never'}</Row>
        </dl>
      </Panel>
      <Panel title="Last run">
        {s.lastRun ? (
          <dl className="flex flex-col gap-2">
            <Row label="When">{formatDateTime(s.lastRunAt)}</Row>
            <Row label="Result">
              <Badge tone={runStatusTone(s.lastRun.status)}>{RUN_STATUS_LABEL[s.lastRun.status]}</Badge>{' '}
              {s.lastRun.kind === 'scan' && s.lastRun.found != null && `found ${s.lastRun.found}, `}
              {s.lastRun.published ?? 0} {s.lastRun.kind === 'research' ? 'note' : 'published'}
            </Row>
            <Row label="Card">
              <Link to={`/cards/${s.lastRun.cardRef}`} className="underline">
                {s.lastRun.cardRef}
              </Link>
            </Row>
            <Row label="Ratings">{describeRatings(s.ratings)}</Row>
            <Row label="Runs, 30 days">{s.runs30d}</Row>
          </dl>
        ) : (
          <p className="text-sm text-subtle">No run yet.</p>
        )}
        {s.failing && (
          <p className="mt-2 text-sm text-danger" data-testid="overview-failing">
            Cannot run ({s.failCount} {s.failCount === 1 ? 'try' : 'tries'}): {s.lastError}
          </p>
        )}
      </Panel>
      <Panel title="Notes">
        {detail.publications.length === 0 ? (
          <p className="text-sm text-subtle">No research notes yet. Use Research this to start one.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" data-testid="interest-publications">
            {detail.publications.map((p) => (
              <li key={p.id}>
                <Link to={`/cards/${p.cardRef}`} className="underline">
                  {p.title}
                </Link>
                {p.vaultPath && <span className="text-xs text-subtle"> · {p.vaultPath}</span>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Members detail={detail} />
    </div>
  );
}

function Members({ detail }: { detail: InterestDetailResponse }) {
  const i = detail.interest;
  const orgMembers = useOrgMembers();
  const share = useShareInterest();
  const unshare = useUnshareInterest();
  const [pick, setPick] = useState('');
  const have = new Set(detail.members.map((m) => m.userId));
  const candidates = (orgMembers.data ?? []).filter((m) => !have.has(m.userId));
  return (
    <Panel title="Who can see it" data-testid="interest-members">
      <ul className="flex flex-col gap-1 text-sm">
        {detail.members.map((m) => (
          <li key={m.userId} className="flex items-center justify-between gap-2">
            <span>
              {m.name}
              {m.orgGrant && <span className="text-subtle"> · Owner or Admin of the organization</span>}
            </span>
            {i.canShare && !m.orgGrant && (
              <Button
                size="sm"
                variant="danger-ghost"
                disabled={unshare.isPending}
                onClick={() => unshare.mutate({ id: i.id, userId: m.userId })}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      {i.canShare && candidates.length > 0 && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <Select
              label="Share with"
              value={pick}
              data-testid="interest-share-pick"
              onChange={(e) => setPick(e.target.value)}
            >
              <option value="">Choose a member</option>
              {candidates.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName}
                </option>
              ))}
            </Select>
          </div>
          <Button
            disabled={!pick}
            loading={share.isPending}
            data-testid="interest-share"
            onClick={() => share.mutate({ id: i.id, userId: pick }, { onSuccess: () => setPick('') })}
          >
            Share
          </Button>
        </div>
      )}
      {!i.canShare && (
        <p className="mt-2 text-xs text-subtle">Only the Owner and Admins can share an interest.</p>
      )}
      <ErrorBox error={share.error ?? unshare.error} />
    </Panel>
  );
}
