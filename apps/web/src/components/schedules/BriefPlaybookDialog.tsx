import {
  BRIEF_OWNER_ROLES,
  BRIEF_PLAYBOOKS,
  type BriefPlaybookDto,
  BUSINESS_ROLES,
  type ScheduleDto,
} from '@aom/shared';
import { useState } from 'react';
import { useInstallBriefPlaybook, usePatchBriefPlaybook } from '../../api/queries/briefPlaybooks.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { useWorkstations } from '../../api/queries/workstations.ts';
import { buildOutputs, draftsFrom, type OutputDraft } from '../../lib/schedules.ts';
import { Button, Dialog, ErrorBox, Select, TextInput, useToast } from '../ui.tsx';
import { OutputSection } from './OutputSection.tsx';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const roleName = (key: string) => BUSINESS_ROLES.find((r) => r.key === key)?.name ?? key;

/** "HH:MM" and weekday of a cron like `30 8 * * 1-5` / `0 7 * * 1`. */
function whenOf(cron: string, fallbackTime: string, fallbackDay: number) {
  const [m, h, , , dow] = cron.split(' ');
  const time =
    h !== undefined && m !== undefined && /^\d+$/.test(h) && /^\d+$/.test(m)
      ? `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
      : fallbackTime;
  return { time, weekday: dow !== undefined && /^\d$/.test(dow) ? Number(dow) : fallbackDay };
}

/**
 * Installs a Brief playbook (one action) or edits an installed one: time, owner role, word cap and where the brief
 * goes. The text the agent is asked to write belongs to the playbook and is not edited here. No secret is typed here.
 */
export function BriefPlaybookDialog({
  playbook,
  schedule,
  onClose,
  onSecret,
}: {
  playbook: BriefPlaybookDto;
  /** Set when the playbook is installed: the dialog edits this schedule. */
  schedule?: ScheduleDto | undefined;
  onClose: () => void;
  onSecret?: ((v: { name: string; value: string }) => void) | undefined;
}) {
  const def = BRIEF_PLAYBOOKS[playbook.key];
  const projects = (useProjects().data ?? []).filter((p) => p.status === 'active');
  const workstations = (useWorkstations().data ?? []).filter((w) => w.status === 'active');
  const install = useInstallBriefPlaybook();
  const patch = usePatchBriefPlaybook();
  const toast = useToast();
  const cur = schedule && schedule.trigger.kind === 'cron' ? schedule.trigger : undefined;
  const when = whenOf(cur?.cron ?? '', def.defaultTime, def.defaultWeekday ?? 1);
  const curAction = schedule?.action.kind === 'create_card' ? schedule.action : undefined;
  const curRole =
    BRIEF_OWNER_ROLES.find((r) => curAction?.template.workflowKey?.endsWith(r.replace(/_/g, '-'))) ??
    def.defaultOwnerRole;
  const curWords = Number(curAction?.template.fields?.maxWords);
  const [time, setTime] = useState(when.time);
  const [weekday, setWeekday] = useState(when.weekday);
  const [timezone, setTimezone] = useState(
    cur?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  );
  const [ownerRole, setOwnerRole] = useState<string>(curRole);
  const [maxWords, setMaxWords] = useState(
    String(Number.isFinite(curWords) && curWords > 0 ? curWords : def.maxWords),
  );
  const [projectId, setProjectId] = useState('');
  const [outputs, setOutputs] = useState<OutputDraft[]>(() =>
    draftsFrom(curAction?.deliverOutput?.destinations ?? []),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = () => {
    const built = buildOutputs(outputs);
    const next = { ...built.errors };
    if (!built.destinations.length)
      next.outputs = 'Choose where the brief goes: add at least one destination.';
    const words = Number(maxWords);
    if (!Number.isInteger(words) || words < 30 || words > 1000)
      next.maxWords = 'Use a whole number from 30 to 1000.';
    if (!schedule && projects.length > 1 && !projectId) next.project = 'Choose a project.';
    setErrors(next);
    if (Object.keys(next).length) return;
    const body = {
      time,
      ...(def.cadence === 'weekly' ? { weekday } : {}),
      timezone: timezone.trim() || 'UTC',
      ownerRole: ownerRole as (typeof BRIEF_OWNER_ROLES)[number],
      maxWords: words,
      destinations: built.destinations,
    };
    const done = (secret?: string) => {
      if (secret) onSecret?.({ name: playbook.name, value: secret });
      toast.success(schedule ? `${playbook.name} saved` : `${playbook.name} installed`);
      onClose();
    };
    if (schedule)
      patch.mutate({ scheduleId: schedule.id, body }, { onSuccess: (r) => done(r.webhookSecret) });
    else
      install.mutate(
        { key: playbook.key, body: { ...body, ...(projectId ? { projectId } : {}) } },
        { onSuccess: (r) => done(r.webhookSecret) },
      );
  };

  const busy = install.isPending || patch.isPending;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={schedule ? `Edit ${playbook.name}` : `Install ${playbook.name}`}
      description={playbook.description}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            className="min-h-11"
            data-testid="playbook-save"
            loading={busy}
            onClick={submit}
          >
            {schedule ? 'Save' : 'Install'}
          </Button>
        </>
      }
    >
      <div className="flex max-h-[70dvh] flex-col gap-4 overflow-y-auto" data-testid="playbook-dialog">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput
            label="Time"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="min-h-11"
            hint={def.cadence === 'workdays' ? 'Monday to Friday' : undefined}
          />
          {def.cadence === 'weekly' && (
            <Select
              label="Day"
              value={weekday}
              onChange={(e) => setWeekday(Number(e.target.value))}
              className="min-h-11"
            >
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
          )}
          <TextInput
            label="Time zone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            hint="IANA name, e.g. Africa/Johannesburg"
            className="min-h-11"
          />
          <Select
            label="Written by"
            value={ownerRole}
            onChange={(e) => setOwnerRole(e.target.value)}
            hint={`Hire a ${roleName(ownerRole)} for the brief to be written.`}
            className="min-h-11"
          >
            {BRIEF_OWNER_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleName(r)}
              </option>
            ))}
          </Select>
          <TextInput
            label="Word cap"
            type="number"
            inputMode="numeric"
            min={30}
            max={1000}
            value={maxWords}
            onChange={(e) => setMaxWords(e.target.value)}
            error={errors.maxWords}
            className="min-h-11"
          />
          {!schedule && projects.length > 1 && (
            <Select
              label="Project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              error={errors.project}
              className="min-h-11"
            >
              <option value="">Choose a project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </div>
        <OutputSection
          outputs={outputs}
          onChange={setOutputs}
          errors={errors}
          workstations={workstations.map((w) => ({ id: w.id, name: w.name }))}
        />
        {errors.outputs && (
          <p className="text-sm text-danger" role="alert">
            {errors.outputs}
          </p>
        )}
        <ErrorBox error={install.error ?? patch.error} />
      </div>
    </Dialog>
  );
}
