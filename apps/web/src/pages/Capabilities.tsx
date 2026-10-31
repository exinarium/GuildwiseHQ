import { useSearchParams } from 'react-router';
import { useMe } from '../api/queries/auth.ts';
import { GrantsTab } from '../components/capabilities/GrantsTab.tsx';
import { MyCapabilitiesTab } from '../components/capabilities/MyCapabilitiesTab.tsx';
import { PacksTab } from '../components/capabilities/PacksTab.tsx';
import { ProjectSkillsTab } from '../components/capabilities/ProjectSkillsTab.tsx';
import { RegistryTab } from '../components/capabilities/RegistryTab.tsx';
import { RoleOffers } from '../components/capabilities/RoleOffers.tsx';
import { StarterGalleryTab } from '../components/capabilities/StarterGallery.tsx';
import { panelId, tabId } from '../components/ui/Tabs.tsx';
import { EmptyState, PageHeader, PageSkeleton, Tabs } from '../components/ui.tsx';
import { useOrgTerms } from '../lib/terms.ts';

const MANAGER_TABS = [
  { id: 'registry', label: 'Registry' },
  { id: 'starter', label: 'Starter gallery' },
  { id: 'mine', label: 'My capabilities' },
  { id: 'packs', label: 'Packs' },
  { id: 'project-skills', label: 'Project skills' },
  { id: 'grants', label: 'Skill grants' },
] as const;
/** Everyone else reads the registry and writes capabilities of their own. */
const MEMBER_TABS = [
  { id: 'registry', label: 'Registry' },
  { id: 'starter', label: 'Starter gallery' },
  { id: 'mine', label: 'My capabilities' },
] as const;

/** Settings > Capabilities: the skills, personas and playbooks your agents can use, and the packs that add more. */
export function Capabilities() {
  const t = useOrgTerms();
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const role = me.data?.activeOrg?.role;
  const manager = role === 'owner' || role === 'admin';
  const asked = params.get('tab');
  const TABS = manager ? MANAGER_TABS : MEMBER_TABS;
  const tab = TABS.find((t) => t.id === asked)?.id ?? 'registry';
  if (me.isPending) return <PageSkeleton label="Loading" />;
  if (!me.data?.activeOrg)
    return (
      <EmptyState title="No organization" description="Join or create an organization to use capabilities." />
    );
  return (
    <div className="mx-auto flex max-w-5xl flex-col">
      <PageHeader
        title="Capabilities"
        sub={t.reword(
          'The skills, personas and playbooks your agents can use: built in, from your vaults and projects, from packs you approve, or written by you.',
        )}
      />
      {manager && <RoleOffers />}
      <Tabs
        label="Capabilities"
        prefix="cap"
        tabs={[...TABS]}
        value={tab}
        onChange={(id) => setParams(id === 'registry' ? {} : { tab: id }, { replace: true })}
      />
      <div role="tabpanel" id={panelId('cap', tab)} aria-labelledby={tabId('cap', tab)}>
        {tab === 'registry' && <RegistryTab />}
        {tab === 'starter' && <StarterGalleryTab />}
        {tab === 'mine' && <MyCapabilitiesTab />}
        {tab === 'packs' && <PacksTab />}
        {tab === 'project-skills' && <ProjectSkillsTab />}
        {tab === 'grants' && <GrantsTab />}
      </div>
    </div>
  );
}
