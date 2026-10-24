import { useSearchParams } from 'react-router';
import { useMe } from '../api/queries/auth.ts';
import { GrantsTab } from '../components/capabilities/GrantsTab.tsx';
import { PacksTab } from '../components/capabilities/PacksTab.tsx';
import { ProjectSkillsTab } from '../components/capabilities/ProjectSkillsTab.tsx';
import { RegistryTab } from '../components/capabilities/RegistryTab.tsx';
import { panelId, tabId } from '../components/ui/Tabs.tsx';
import { EmptyState, PageHeader, PageSkeleton, Tabs } from '../components/ui.tsx';

const TABS = [
  { id: 'registry', label: 'Registry' },
  { id: 'packs', label: 'Packs' },
  { id: 'project-skills', label: 'Project skills' },
  { id: 'grants', label: 'Skill grants' },
] as const;

/** Settings > Capabilities: the skills, personas and playbooks your agents can use, and the packs that add more. */
export function Capabilities() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const role = me.data?.activeOrg?.role;
  const manager = role === 'owner' || role === 'admin';
  const asked = params.get('tab');
  const tab = TABS.find((t) => t.id === asked)?.id ?? 'registry';
  if (me.isPending) return <PageSkeleton label="Loading" />;
  if (!manager)
    return (
      <EmptyState
        title="Owners and Admins only"
        description="Ask an Owner or Admin to manage capabilities and packs."
      />
    );
  return (
    <div className="mx-auto flex max-w-5xl flex-col">
      <PageHeader
        title="Capabilities"
        sub="The skills, personas and playbooks your agents can use: built in, from your vaults and projects, or from packs you approve."
      />
      <Tabs
        label="Capabilities"
        prefix="cap"
        tabs={[...TABS]}
        value={tab}
        onChange={(id) => setParams(id === 'registry' ? {} : { tab: id }, { replace: true })}
      />
      <div role="tabpanel" id={panelId('cap', tab)} aria-labelledby={tabId('cap', tab)}>
        {tab === 'registry' && <RegistryTab />}
        {tab === 'packs' && <PacksTab />}
        {tab === 'project-skills' && <ProjectSkillsTab />}
        {tab === 'grants' && <GrantsTab />}
      </div>
    </div>
  );
}
