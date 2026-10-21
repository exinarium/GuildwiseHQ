import { useSearchParams } from 'react-router';
import { useReleaseQueue } from '../api/queries/delivery.ts';
import { DeployRuns } from '../components/delivery/DeployRuns.tsx';
import { RulesPanel } from '../components/delivery/GatesPanel.tsx';
import { LiveMatrix } from '../components/delivery/LiveMatrix.tsx';
import { ReleaseQueue } from '../components/delivery/ReleaseQueue.tsx';
import { panelId, tabId } from '../components/ui/Tabs.tsx';
import { Badge, Callout, PageHeader, Tabs } from '../components/ui.tsx';
import { useCanManageOrg } from '../lib/orgRole.ts';

const PREFIX = 'releases';
type TabKey = 'waiting' | 'live' | 'history' | 'rules';

/**
 * Releases (docs/design/environments-ux.md section 5.5): what needs a decision or is moving, across projects. Waiting for you
 * (the release queue), What is live, History and Rules. The Owner or an Admin releases; everyone else reads What is live and
 * History. Setting up where an app runs happens on the project's Environments page, not here.
 */
export function Releases() {
  const manage = useCanManageOrg();
  const [params, setParams] = useSearchParams();
  const queue = useReleaseQueue(manage);
  const waiting = queue.data?.length ?? 0;
  const tabs: Array<{ id: TabKey; label: string; badge?: React.ReactNode }> = manage
    ? [
        {
          id: 'waiting',
          label: 'Waiting for you',
          ...(waiting > 0 ? { badge: <Badge tone="brand">{waiting}</Badge> } : {}),
        },
        { id: 'live', label: 'What is live' },
        { id: 'history', label: 'History' },
        { id: 'rules', label: 'Rules' },
      ]
    : [
        { id: 'live', label: 'What is live' },
        { id: 'history', label: 'History' },
      ];
  const asked = params.get('tab');
  const value: TabKey = tabs.some((t) => t.id === asked) ? (asked as TabKey) : (tabs[0]?.id as TabKey);
  return (
    <div className="mx-auto flex max-w-4xl flex-col" data-testid="releases-page">
      <PageHeader
        title="Releases"
        sub="Which version is live on each site, what is waiting for you, and what was released."
      />
      {!manage && (
        <Callout tone="info" className="mb-4" data-testid="releases-readonly">
          Only an Owner or an Admin of the organization releases. You can see what is live and the history.
        </Callout>
      )}
      <Tabs
        label="Releases"
        prefix={PREFIX}
        tabs={tabs.map((t) => ({ ...t, testId: `releases-tab-${t.id}` }))}
        value={value}
        onChange={(id) => setParams({ tab: id }, { replace: true })}
      />
      <div role="tabpanel" id={panelId(PREFIX, value)} aria-labelledby={tabId(PREFIX, value)}>
        {value === 'waiting' && manage && <ReleaseQueue />}
        {value === 'live' && <LiveMatrix canRelease={manage} />}
        {value === 'history' && <DeployRuns filters />}
        {value === 'rules' && manage && <RulesPanel canEdit={manage} />}
      </div>
    </div>
  );
}
