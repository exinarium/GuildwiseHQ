import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  useArchiveInterest,
  useDeleteInterest,
  useDeliverInterest,
  useInterest,
  useRestoreInterest,
  useRunInterest,
} from '../api/queries/interests.ts';
import { BudgetBanner } from '../components/BudgetBanner.tsx';
import { DigestTab } from '../components/interests/DigestTab.tsx';
import { ActiveTick } from '../components/interests/InterestCard.tsx';
import { OverviewTab } from '../components/interests/OverviewTab.tsx';
import { ResearchThisDialog } from '../components/interests/ResearchThisDialog.tsx';
import { RunLog } from '../components/interests/RunLog.tsx';
import { SettingsTab } from '../components/interests/SettingsTab.tsx';
import { TasteTab } from '../components/interests/TasteTab.tsx';
import { panelId, tabId } from '../components/ui/Tabs.tsx';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  Menu,
  MenuItem,
  PageHeader,
  PageSkeleton,
  Tabs,
  TextInput,
  useToast,
} from '../components/ui.tsx';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'runs', label: 'Run log' },
  { id: 'digest', label: 'Digest' },
  { id: 'settings', label: 'Settings' },
  { id: 'taste', label: 'Taste' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/** One interest: Overview, Run log, Digest, Settings and Taste. A full page on every screen size. */
export function InterestDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const detail = useInterest(id);
  const run = useRunInterest();
  const deliver = useDeliverInterest();
  const archive = useArchiveInterest();
  const restore = useRestoreInterest();
  const del = useDeleteInterest();
  const toast = useToast();
  const [researching, setResearching] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [slugText, setSlugText] = useState('');
  const tabParam = params.get('tab') as TabId | null;
  const tab: TabId = TABS.some((t) => t.id === tabParam) ? (tabParam as TabId) : 'overview';

  if (detail.isPending) return <PageSkeleton label="Loading the interest" />;
  if (!detail.data)
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorBox error={detail.error} onRetry={() => detail.refetch()} />
        <EmptyState
          title="Interest not found"
          description="It may have been deleted, or you cannot see it."
        />
      </div>
    );
  const i = detail.data.interest;
  const canAct = i.canManage && !i.archived;
  return (
    <div className="mx-auto flex max-w-5xl flex-col" data-testid="interest-detail">
      <PageHeader
        back={{ to: '/interests', label: 'Interests' }}
        title={i.name}
        documentTitle={`${i.name} · Interests`}
        sub={
          <span className="text-sm text-subtle" data-testid="interest-sub">
            Organization vault{i.vaultDir ? ` · ${i.vaultDir}` : ''}
            {i.createdBy ? ` · created by ${i.createdBy.name}` : ''}
          </span>
        }
        eyebrow={
          i.archived ? (
            <Badge tone="neutral" className="mb-1">
              Archived
            </Badge>
          ) : undefined
        }
        actions={
          <>
            <ActiveTick interest={i} size="lg" />
            {canAct && (
              <>
                <Button
                  variant="primary"
                  loading={run.isPending}
                  data-testid="interest-run"
                  onClick={() =>
                    run.mutate({ id: i.id }, { onSuccess: (r) => toast.success(`Scan started: ${r.ref}`) })
                  }
                >
                  Run scan
                </Button>
                <Button data-testid="interest-research" onClick={() => setResearching(true)}>
                  Research this
                </Button>
                {i.stats.items.held > 0 && (
                  <Button
                    loading={deliver.isPending}
                    data-testid="interest-deliver"
                    onClick={() =>
                      deliver.mutate(i.id, {
                        onSuccess: (r) =>
                          toast.success(
                            `${r.delivered} ${r.delivered === 1 ? 'item' : 'items'} delivered${r.heldBack ? `, ${r.heldBack} held back by the quiet cap` : ''}`,
                          ),
                      })
                    }
                  >
                    Deliver {i.stats.items.held} now
                  </Button>
                )}
              </>
            )}
            {i.canManage && (
              <Menu label="More actions">
                {i.archived ? (
                  <MenuItem
                    onSelect={() =>
                      restore.mutate(i.id, { onSuccess: () => toast.success('Interest restored') })
                    }
                  >
                    Restore
                  </MenuItem>
                ) : (
                  <MenuItem
                    description="Stops its runs and hides it. You can restore it."
                    onSelect={() => setConfirmArchive(true)}
                  >
                    Archive
                  </MenuItem>
                )}
                {i.archived && (
                  <MenuItem
                    danger
                    description="Removes its cards, items and run log for good."
                    onSelect={() => setDeleting(true)}
                  >
                    Delete permanently
                  </MenuItem>
                )}
              </Menu>
            )}
          </>
        }
      />
      <ErrorBox error={run.error ?? deliver.error ?? archive.error ?? restore.error} />
      <BudgetBanner
        budget={i.budget}
        projectId={i.id}
        kind="interests"
        name={i.name}
        settingsTo={`/interests/${i.id}?tab=settings#budget`}
      />
      <Tabs
        label="Interest sections"
        prefix="interest"
        tabs={TABS.map((t) => ({
          id: t.id,
          label: t.label,
          testId: `interest-tab-${t.id}`,
          ...(t.id === 'digest' && i.stats.items.held > 0
            ? { badge: <Badge tone="blue">{i.stats.items.held} waiting</Badge> }
            : {}),
        }))}
        value={tab}
        onChange={(t) => {
          const next = new URLSearchParams(params);
          if (t === 'overview') next.delete('tab');
          else next.set('tab', t);
          setParams(next, { replace: true });
        }}
      />
      <div role="tabpanel" id={panelId('interest', tab)} aria-labelledby={tabId('interest', tab)}>
        {tab === 'overview' && <OverviewTab detail={detail.data} />}
        {tab === 'runs' && <RunLog interestId={i.id} />}
        {tab === 'digest' && <DigestTab interest={i} />}
        {tab === 'settings' && <SettingsTab key={i.updatedAt} interest={i} />}
        {tab === 'taste' && <TasteTab interestId={i.id} canManage={canAct} />}
      </div>

      {researching && <ResearchThisDialog interest={i} onClose={() => setResearching(false)} />}
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={`Archive "${i.name}"?`}
        description="It stops running and leaves the list. Open runs are cancelled. Its items, notes and run log are kept, and you can restore it."
        confirmLabel="Archive"
        pending={archive.isPending}
        onConfirm={() =>
          archive.mutate(i.id, {
            onSuccess: () => {
              setConfirmArchive(false);
              toast.success('Interest archived');
            },
          })
        }
      />
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete "${i.name}" for good?`}
        description={`This removes its cards, items, seen-list and run log from the site. The vault folder ${i.vaultDir ?? ''} is never touched.`}
        footer={
          <>
            <Button onClick={() => setDeleting(false)}>Cancel</Button>
            <Button
              variant="danger"
              loading={del.isPending}
              disabled={slugText !== i.slug}
              data-testid="interest-delete-confirm"
              onClick={() =>
                i.slug &&
                del.mutate({ id: i.id, confirmSlug: i.slug }, { onSuccess: () => nav('/interests') })
              }
            >
              Delete interest
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2" data-testid="interest-delete-dialog">
          <TextInput
            label={`Type ${i.slug ?? 'the folder name'} to confirm`}
            value={slugText}
            data-testid="interest-delete-slug"
            onChange={(e) => setSlugText(e.target.value)}
          />
          <ErrorBox error={del.error} />
        </div>
      </Dialog>
    </div>
  );
}
