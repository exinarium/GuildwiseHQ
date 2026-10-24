import { useSearchParams } from 'react-router';
import { useMe } from '../api/queries/auth.ts';
import { useOrg } from '../api/queries/orgs.ts';
import { BillingTab } from '../components/orgsettings/BillingTab.tsx';
import { GeneralTab } from '../components/orgsettings/GeneralTab.tsx';
import { GuestsTab } from '../components/orgsettings/GuestsTab.tsx';
import { InvitationsTab } from '../components/orgsettings/InvitationsTab.tsx';
import { MailInboxTab } from '../components/orgsettings/MailInboxTab.tsx';
import { MembersTab } from '../components/orgsettings/MembersTab.tsx';
import { PlanTab } from '../components/orgsettings/PlanTab.tsx';
import { ProjectLinksTab } from '../components/orgsettings/ProjectLinksTab.tsx';
import { panelId, tabId } from '../components/ui/Tabs.tsx';
import { EmptyState, ErrorBox, PageHeader, PageSkeleton, Tabs } from '../components/ui.tsx';
import { OrgProvidersBody } from './OrgProviders.tsx';

type TabId =
  | 'general'
  | 'members'
  | 'invitations'
  | 'guests'
  | 'mail'
  | 'links'
  | 'providers'
  | 'plan'
  | 'billing';

/** `/settings/org`: General, Members, Invitations, Guests, Plan & limits (docs/design/organizations.md section 11.2). */
export function OrgSettings() {
  const me = useMe();
  const org = useOrg(!!me.data?.activeOrg);
  const [params, setParams] = useSearchParams();
  const role = me.data?.activeOrg?.role;
  const manager = role === 'owner' || role === 'admin';
  const tabs = [
    { id: 'general', label: 'General' },
    { id: 'members', label: 'Members' },
    ...(manager
      ? [
          { id: 'invitations', label: 'Invitations' },
          { id: 'guests', label: 'Guests' },
          { id: 'mail', label: 'E-mail inbox' },
          { id: 'links', label: 'Project links' },
          { id: 'providers', label: 'Model providers' },
          { id: 'plan', label: 'Plan & limits' },
        ]
      : []),
    ...(role === 'owner' ? [{ id: 'billing', label: 'Billing' }] : []),
  ];
  const wanted = (params.get('tab') ?? 'general') as TabId;
  const tab = tabs.some((t) => t.id === wanted) ? wanted : 'general';

  if (!me.data?.activeOrg)
    return (
      <EmptyState
        title="You do not belong to an organization"
        description="Ask an Owner or Admin for an invitation, or ask your platform administrator to set one up for you."
      />
    );
  if (org.isPending) return <PageSkeleton label="Loading organization" />;
  if (!org.data) return <ErrorBox error={org.error} />;

  return (
    <div className="mx-auto flex max-w-4xl flex-col">
      <PageHeader
        title="Organization"
        sub={`${org.data.name} · you are ${role === 'admin' ? 'an Admin' : role === 'owner' ? 'the Owner' : 'a Member'}`}
      />
      <Tabs
        label="Organization settings"
        prefix="org"
        tabs={tabs}
        value={tab}
        onChange={(id) => setParams(id === 'general' ? {} : { tab: id }, { replace: true })}
      />
      <div role="tabpanel" id={panelId('org', tab)} aria-labelledby={tabId('org', tab)}>
        {tab === 'general' && <GeneralTab org={org.data} userId={me.data.user.id} />}
        {tab === 'members' && role && <MembersTab me={{ userId: me.data.user.id, role }} />}
        {tab === 'invitations' && manager && role && (
          <InvitationsTab role={role === 'owner' ? 'owner' : 'admin'} />
        )}
        {tab === 'guests' && manager && <GuestsTab />}
        {tab === 'mail' && manager && role && <MailInboxTab orgRole={role === 'owner' ? 'owner' : 'admin'} />}
        {tab === 'links' && manager && <ProjectLinksTab />}
        {tab === 'providers' && manager && <OrgProvidersBody />}
        {tab === 'plan' && manager && <PlanTab org={org.data} />}
        {tab === 'billing' && role === 'owner' && <BillingTab />}
      </div>
    </div>
  );
}
