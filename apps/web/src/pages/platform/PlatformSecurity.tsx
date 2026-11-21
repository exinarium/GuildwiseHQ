import { ShieldCheck } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { BlockListPanel } from '../../components/platform/BlockListPanel.tsx';
import { panelId, tabId } from '../../components/ui/Tabs.tsx';
import { EmptyState, PageHeader, Tabs } from '../../components/ui.tsx';
import { SecuritySettingsPanel } from './SecuritySettingsPanel.tsx';
import { FailedSignInsPanel, SignInsPanel } from './security/SignInPanels.tsx';

export type PlatformSecurityTab = 'failed' | 'signins' | 'blocklist' | 'settings';

const TABS: Array<{ id: PlatformSecurityTab; label: string }> = [
  { id: 'failed', label: 'Failed sign-ins' },
  { id: 'signins', label: 'Sign-ins' },
  { id: 'blocklist', label: 'Block list' },
  { id: 'settings', label: 'Security settings' },
];

/**
 * The content of each tab. The frame and the tab names are fixed here; each tab's own component replaces its entry
 * (failed and successful sign-ins, the block list, the security settings with the hosted lock).
 */
const PANELS: Record<PlatformSecurityTab, () => ReactNode> = {
  failed: () => <FailedSignInsPanel />,
  signins: () => <SignInsPanel />,
  blocklist: () => <BlockListPanel />,
  settings: () => <SecuritySettingsPanel />,
};

function Empty({ title }: { title: string }) {
  return <EmptyState icon={ShieldCheck} title={title} />;
}

/** `/platform/security`: sign-in protection, the owner's block list and the security settings (1.10.0). */
export function PlatformSecurity({ initialTab = 'failed' }: { initialTab?: PlatformSecurityTab }) {
  const [tab, setTab] = useState<PlatformSecurityTab>(initialTab);
  return (
    <div data-testid="platform-security">
      <PageHeader
        title="Security"
        sub="Failed and successful sign-ins, the block list, and the security settings of this installation."
      />
      <Tabs
        label="Security"
        prefix="security"
        value={tab}
        onChange={(v) => setTab(v as PlatformSecurityTab)}
        tabs={TABS.map((t) => ({ ...t, testId: `security-tab-${t.id}` }))}
      />
      <div role="tabpanel" id={panelId('security', tab)} aria-labelledby={tabId('security', tab)}>
        {PANELS[tab]()}
      </div>
    </div>
  );
}
