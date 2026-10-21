import { useRunPlanOverview } from '../../api/queries/run-plan.ts';
import { RunSettingsTechnical } from '../runs/RunSettings.tsx';
import { RunStepsCard } from '../runs/RunStepsCard.tsx';
import { Badge, Disclosure, Spinner } from '../ui.tsx';
import { Section } from './Section.tsx';

/**
 * Your app: how to start it (docs/design/environments-ux.md 5.1). The start steps are the one shared dependency of the test
 * copies and of the environments on this computer that do not already run; the card is the existing run-steps editor in a new
 * frame, and the free-text notes for DevOps sit behind "technical details".
 */
export function YourAppCard({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const o = useRunPlanOverview(projectId).data;
  const plan = o?.projectPlan?.plan;
  if (!o) return <Spinner label="Loading the start steps" />;
  const failed = o?.lastStart?.state === 'failed';
  const chip = o?.scan ? (
    <Badge tone="blue">Looking</Badge>
  ) : o?.proposal?.proposal.run ? (
    <Badge tone="amber">Suggestion waiting</Badge>
  ) : !plan ? (
    <Badge tone="neutral" data-testid="your-app-chip">
      Needs steps
    </Badge>
  ) : failed ? (
    <Badge tone="red" data-testid="your-app-chip">
      Last start failed
    </Badge>
  ) : (
    <Badge tone="green" data-testid="your-app-chip">
      Ready
    </Badge>
  );
  return (
    <Section
      id="start-steps"
      testId="your-app"
      title="Your app: how to start it"
      sub="Test copies of cards and environments on this computer that do not already run use these steps."
      chip={chip}
      collapsible={!!plan && !o.proposal && !o.scan}
    >
      <RunStepsCard projectId={projectId} canEdit={canEdit} />
      <Disclosure
        summary="Notes for DevOps (technical details)"
        className="border-t border-line pt-3"
        data-testid="run-technical"
      >
        <RunSettingsTechnical projectId={projectId} canEdit={canEdit} />
      </Disclosure>
    </Section>
  );
}
