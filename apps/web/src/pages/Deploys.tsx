import { DeployRuns } from '../components/delivery/DeployRuns.tsx';
import { GatesPanel } from '../components/delivery/GatesPanel.tsx';
import { ReleaseQueue } from '../components/delivery/ReleaseQueue.tsx';
import { Callout, PageHeader } from '../components/ui.tsx';
import { useCanManageOrg } from '../lib/orgRole.ts';

/**
 * Deploys (docs/design/ceo-front-door.md 9 and 14.2): the release queue (ready releases: commit, environment and target; the
 * Owner or an Admin presses Release and, for an environment with several servers, chooses which), the recent runs with the audit
 * (which approved recipe version, which gate and evidence, released by whom) and the organization's gate presets.
 */
export function Deploys() {
  const canManage = useCanManageOrg();
  if (!canManage)
    return (
      <>
        <PageHeader title="Deploys" />
        <Callout tone="info">Only an Owner or an Admin of the organization releases deploys.</Callout>
      </>
    );
  return (
    <>
      <PageHeader
        title="Deploys"
        sub="Releases waiting for you, what was deployed and why it was allowed, and the rules that gate it."
      />
      <div className="flex flex-col gap-5">
        <ReleaseQueue />
        <DeployRuns />
        <GatesPanel />
      </div>
    </>
  );
}
