import { Settings2 } from 'lucide-react';
import { useState } from 'react';
import { useRunPlanOverview } from '../../api/queries/run-plan.ts';
import { useIntegrationTests, useRuns } from '../../api/queries/runs.ts';
import { IntegrationTestsSettings } from '../runs/IntegrationTestsSettings.tsx';
import { RunList } from '../runs/RunPanel.tsx';
import { Badge, Button, Callout, Dialog, Disclosure } from '../ui.tsx';

/**
 * Test copies: one per card, temporary (docs/design/environments-ux.md journey L). It says where they run, how long a failed
 * one is kept, what is running right now with its expiry, and holds the tests that run on a test copy.
 */
export function TestCopiesCard({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const runs = useRuns({ projectId });
  const plan = useRunPlanOverview(projectId).data;
  const tests = useIntegrationTests(projectId).data?.settings;
  const [editing, setEditing] = useState(false);
  const live = runs.data ?? [];
  const failed = live.filter((r) => r.state === 'failed');
  const hasPlan = !!plan?.projectPlan;
  const computers = (plan?.workstations ?? []).map((w) => w.name);
  const keep = tests?.keepOnFailureMin;
  const chip = !hasPlan ? (
    <Badge>Not set up</Badge>
  ) : failed.length > 0 ? (
    <Badge tone="red">Failed</Badge>
  ) : (
    <Badge tone="green">Healthy</Badge>
  );
  return (
    <li
      className="flex list-none flex-col gap-3 rounded-card border border-line bg-surface p-4"
      data-testid="test-copies"
    >
      <section aria-labelledby="test-copies-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="test-copies-title" className="text-base font-semibold text-fg">
            Test copies
          </h3>
          <span className="text-sm text-muted">one per card, temporary</span>
          <span className="ml-auto">{chip}</span>
        </div>
        {!hasPlan && (
          <Callout tone="warning" data-testid="test-copies-needs-steps">
            Card tests need your start steps.{' '}
            <a className="font-medium underline" href="#start-steps">
              Set them up
            </a>
          </Callout>
        )}
        <dl className="grid gap-x-4 gap-y-1 text-sm grid-cols-[5.5rem_1fr]">
          <dt className="text-subtle">Runs on</dt>
          <dd className="text-fg">
            {computers.length ? computers.join(', ') : 'Any computer of this project'}
          </dd>
          <dt className="text-subtle">Kept</dt>
          <dd className="text-fg" data-testid="test-copies-keep">
            {keep
              ? `${keep >= 60 ? `${Math.round(keep / 60)} h` : `${keep} min`} after a card fails, so you can look`
              : 'Stopped when the card is done'}
          </dd>
          <dt className="text-subtle">Right now</dt>
          <dd className="text-fg" data-testid="test-copies-now">
            {live.length === 0
              ? 'Nothing is running'
              : `${live.length} running (${live.map((r) => r.cardRef ?? 'manual').join(', ')})`}
          </dd>
        </dl>
        {live.length > 0 && (
          <Disclosure summary={`Show the ${live.length} running`} data-testid="test-copies-list">
            <RunList envs={live} />
          </Disclosure>
        )}
        {canEdit && (
          <div>
            <Button size="sm" onClick={() => setEditing(true)} data-testid="test-copies-change">
              <Settings2 aria-hidden="true" className="size-4" />
              Tests and settings
            </Button>
          </div>
        )}
      </section>
      {editing && (
        <Dialog
          open
          onOpenChange={(o) => !o && setEditing(false)}
          title="Tests that run on a test copy"
          size="xl"
        >
          <IntegrationTestsSettings projectId={projectId} canEdit={canEdit} />
        </Dialog>
      )}
    </li>
  );
}
