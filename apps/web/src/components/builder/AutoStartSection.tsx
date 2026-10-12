import type { ScheduleDto } from '@aom/shared';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useWorkflows } from '../../api/queries/agents.ts';
import { useScheduleList } from '../../api/queries/schedules.ts';
import { describeTrigger } from '../../lib/schedules.ts';
import { ScheduleWizard } from '../schedules/ScheduleWizard.tsx';
import { Badge, Button } from '../ui.tsx';

/** The card events that start work in one workflow; the section lists the automations that use them. */
const WORKFLOW_EVENTS = new Set(['card_stage_reached', 'card_done', 'investigation_reported']);

/**
 * "Starts automatically when ...": the automations that react to cards of this workflow, and a way to add one. The
 * form is the Automations wizard with the workflow already chosen. A workflow that is not approved yet cannot be named
 * by an automation, so adding waits for that.
 */
export function AutoStartSection({ workflowKey, readOnly }: { workflowKey: string; readOnly?: boolean }) {
  const list = useScheduleList();
  const workflows = useWorkflows();
  const [wizard, setWizard] = useState<{ open: boolean; editing?: ScheduleDto }>({ open: false });
  const active = (workflows.data ?? []).some((w) => w.definition.key === workflowKey);
  const mine = (list.data?.schedules ?? []).filter(
    (s) =>
      s.trigger.kind === 'event' &&
      WORKFLOW_EVENTS.has(s.trigger.event) &&
      s.trigger.workflowKey === workflowKey,
  );

  return (
    <section aria-labelledby="autostart-title" className="flex flex-col gap-3" data-testid="autostart">
      <div>
        <h2 id="autostart-title" className="text-base font-semibold">
          Starts automatically when...
        </h2>
        <p className="text-xs text-subtle">
          Automations that react to cards of this workflow, for example to make a follow-up card when one is
          done.
        </p>
      </div>
      {mine.length === 0 ? (
        <p className="text-sm text-muted" data-testid="autostart-empty">
          Nothing starts from this workflow automatically.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Automations of this workflow">
          {mine.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-2 rounded-panel border border-line px-3 py-2"
              data-testid={`autostart-${s.name}`}
            >
              <span className="font-medium text-fg">{s.name}</span>
              <span className="text-sm text-muted">{describeTrigger(s.trigger)}</span>
              <Badge tone={s.enabled ? 'green' : 'amber'}>{s.enabled ? 'Enabled' : 'Paused'}</Badge>
              {!readOnly && s.canEdit !== false && (
                <Button className="ml-auto" onClick={() => setWizard({ open: true, editing: s })}>
                  Edit
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div>
          <Button data-testid="autostart-add" disabled={!active} onClick={() => setWizard({ open: true })}>
            <Plus aria-hidden="true" className="size-4" />
            Add trigger
          </Button>
          {!active && (
            <p className="mt-1 text-xs text-subtle">
              Available once this workflow is approved and active: an automation can only name an active
              workflow.
            </p>
          )}
        </div>
      )}
      <ScheduleWizard
        open={wizard.open}
        onOpenChange={(open) => setWizard((cur) => ({ ...cur, open }))}
        editing={wizard.editing}
        initial={{ triggerKind: 'event', event: 'card_done', eventWorkflowKey: workflowKey }}
      />
    </section>
  );
}
