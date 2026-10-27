import {
  type CardTemplate,
  type CreateScheduleResponse,
  SCHEDULE_EVENT_TRIGGERS,
  SCHEDULE_PRESETS,
  type ScheduleDto,
  WEBHOOK_FORMATS,
} from '@aom/shared';
import {
  CalendarClock,
  ClipboardList,
  FilePlus2,
  FlaskConical,
  Hand,
  Inbox,
  type LucideIcon,
  Mail,
  Radio,
  Reply,
  Tag,
  Ticket,
  Webhook,
  Wrench,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkflows } from '../../api/queries/agents.ts';
import { useMe } from '../../api/queries/auth.ts';
import { useMailInboxes } from '../../api/queries/mail.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { useCreateSchedule, usePatchSchedule } from '../../api/queries/schedules.ts';
import { useWorkstations } from '../../api/queries/workstations.ts';
import {
  ACTION_TILES,
  type ActionTile,
  buildScheduleRequest,
  CUSTOM_PRESET,
  emptyWizard,
  formFromTemplate,
  isEventName,
  isMailKind,
  isReactiveKind,
  stateFromSchedule,
  TRIGGER_TILES,
  type TriggerKind,
  WEBHOOK_FORMAT_LABEL,
  type WizardState,
  wizardIsOrgLevel,
} from '../../lib/schedules.ts';
import { CardFormFields } from '../CardFormFields.tsx';
import { HelpHint } from '../help/HelpHint.tsx';
import { cx } from '../ui/cx.ts';
import { Button, Callout, Dialog, ErrorBox, Select, Stepper, TextArea, TextInput, useToast } from '../ui.tsx';
import { MappingEditor } from './MappingEditor.tsx';

const TRIGGER_ICON: Record<TriggerKind, LucideIcon> = {
  cron: CalendarClock,
  event: Radio,
  intake_ticket: Ticket,
  email_received: Mail,
  email_reply: Reply,
  webhook_in: Webhook,
  issue_labelled: Tag,
  manual: Hand,
};
const ACTION_ICON: Record<ActionTile, LucideIcon> = {
  create_card: FilePlus2,
  regression_run: FlaskConical,
  devops_request: Wrench,
  ba_task: ClipboardList,
  github: Inbox,
  jira: Inbox,
  webhook: Webhook,
  email: Mail,
};
const STEPS = [
  { id: 'trigger', label: 'When', color: 'var(--stage-progress)' },
  { id: 'action', label: 'What', color: 'var(--stage-spec)' },
  { id: 'details', label: 'Details', color: 'var(--stage-done)' },
];

function TileGrid<T extends string>({
  label,
  value,
  onChange,
  tiles,
  icons,
  disabled,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  tiles: Array<{ id: T; label: string; description: string }>;
  icons: Record<string, LucideIcon>;
  disabled?: (id: T) => string | null;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-2 sm:grid-cols-2">
      {tiles.map((t) => {
        const Icon = icons[t.id] as LucideIcon;
        const why = disabled?.(t.id) ?? null;
        const selected = value === t.id;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a tile-styled radio
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={!!why}
            data-testid={`tile-${t.id}`}
            onClick={() => onChange(t.id)}
            className={cx(
              'flex items-start gap-3 rounded-panel border p-3 text-left transition-colors',
              selected ? 'border-brand bg-brand-soft' : 'border-line bg-surface hover:border-control',
              why && 'cursor-not-allowed opacity-60 hover:border-line',
            )}
          >
            <span
              aria-hidden="true"
              className={cx(
                'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control',
                selected ? 'bg-brand text-brand-fg' : 'bg-sunken text-muted',
              )}
            >
              <Icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-base font-semibold text-fg">{t.label}</span>
              <span className="block text-sm text-muted">{why ?? t.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ScheduleWizard({
  open,
  onOpenChange,
  editing,
  onCreated,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: ScheduleDto | undefined;
  /** A new automation starts from these values (the builder's "Starts automatically when" section). */
  initial?: Partial<WizardState> | undefined;
  /** A new webhook schedule's signing secret, shown once by the caller. */
  onCreated?: (created: CreateScheduleResponse) => void;
}) {
  // Remount per open so each use starts from its own state (a new schedule, or the one being edited).
  return open ? (
    <WizardDialog
      key={editing?.id ?? 'new'}
      onOpenChange={onOpenChange}
      editing={editing}
      onCreated={onCreated}
      initial={initial}
    />
  ) : null;
}

function WizardDialog({
  onOpenChange,
  editing,
  onCreated,
  initial,
}: {
  onOpenChange: (open: boolean) => void;
  editing: ScheduleDto | undefined;
  onCreated: ((c: CreateScheduleResponse) => void) | undefined;
  initial: Partial<WizardState> | undefined;
}) {
  const me = useMe().data;
  const projects = useProjects();
  const workstations = useWorkstations();
  const create = useCreateSchedule();
  const patch = usePatchSchedule();
  const toast = useToast();
  const [step, setStep] = useState(editing ? 2 : 0);
  const [s, setS] = useState<WizardState>(() =>
    editing ? stateFromSchedule(editing) : emptyWizard(initial),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const isManager = me?.activeOrg?.role === 'owner' || me?.activeOrg?.role === 'admin';
  const myWorkstations = (workstations.data ?? []).filter((w) => w.status === 'active');
  const myProjects = (projects.data ?? []).filter((p) => p.status === 'active');
  const set = (patchState: Partial<WizardState>) => setS((cur) => ({ ...cur, ...patchState }));

  const projectForCard = myProjects.find((p) => p.id === s.projectId);
  const workflows = useWorkflows(s.tile === 'create_card' ? projectForCard?.id : undefined);
  const workflow = useMemo(
    () =>
      workflows.data
        ?.filter((w) => w.definition.key === projectForCard?.workflowKey)
        .sort((a, b) => b.definition.version - a.definition.version)[0]?.definition,
    [workflows.data, projectForCard?.workflowKey],
  );

  // Editing a card schedule: its field values need the workflow to be shown as text, so they load when it arrives.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!editing || hydrated.current || !workflow || editing.action.kind !== 'create_card') return;
    hydrated.current = true;
    setS((cur) => ({
      ...cur,
      card: formFromTemplate((editing.action as { template: CardTemplate }).template, workflow),
    }));
  }, [editing, workflow]);

  // A new card template starts with the workflow's first card type.
  useEffect(() => {
    if (workflow && !s.card.cardType && workflow.cardTypes[0])
      setS((cur) => ({ ...cur, card: { ...cur.card, cardType: workflow.cardTypes[0] as string } }));
  }, [workflow, s.card.cardType]);

  /** The trigger step's own fields, checked before moving on. */
  const triggerOk = (): boolean => {
    const r = buildScheduleRequest({ ...s, name: s.name || 'x' }, { workflow, mockUi: false });
    const mine = [
      'cron',
      'timezone',
      'labelQuery',
      'label',
      'workstationId',
      'eventWorkflowKey',
      'eventStageId',
      'filterEquals',
      'inboxId',
      'mailFrom',
    ];
    const e = Object.fromEntries(Object.entries(r.errors).filter(([k]) => mine.includes(k)));
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = () => {
    const r = buildScheduleRequest(s, {
      workflow,
      mockUi: me?.features?.mockUi ?? false,
      myEmail: me?.user.email,
    });
    setErrors(r.errors);
    if (!r.body) {
      // Take the user to the step that holds the first error.
      const first = Object.keys(r.errors)[0] ?? '';
      if (
        [
          'cron',
          'timezone',
          'labelQuery',
          'label',
          'eventWorkflowKey',
          'eventStageId',
          'filterEquals',
          'inboxId',
          'mailFrom',
        ].includes(first)
      )
        setStep(0);
      return;
    }
    if (editing) {
      patch.mutate(
        {
          id: editing.id,
          body: {
            name: r.body.name,
            enabled: r.body.enabled,
            trigger: r.body.trigger,
            action: r.body.action,
          },
        },
        {
          onSuccess: () => {
            toast.success('Automation saved');
            onOpenChange(false);
          },
        },
      );
    } else {
      create.mutate(r.body, {
        onSuccess: (created) => {
          toast.success('Automation created');
          onCreated?.(created);
          onOpenChange(false);
        },
      });
    }
  };

  const orgLevel = wizardIsOrgLevel(s);
  const blockedOrgLevel = orgLevel && !isManager;
  const tileDisabled = (id: ActionTile): string | null => {
    const t = ACTION_TILES.find((x) => x.id === id);
    if (t?.notWith?.includes(s.triggerKind)) return 'Not available with this trigger.';
    return null;
  };

  const header = (
    <div className="mb-4">
      <Stepper steps={STEPS} currentId={STEPS[step]?.id ?? 'trigger'} label="Automation steps" />
    </div>
  );

  const footer = (
    <>
      {step > 0 && !editing && (
        <Button onClick={() => setStep(step - 1)} className="sm:mr-auto">
          Back
        </Button>
      )}
      <Button onClick={() => onOpenChange(false)}>Cancel</Button>
      {step < 2 ? (
        <Button
          variant="primary"
          data-testid="wizard-next"
          onClick={() => {
            if (step === 0 && !triggerOk()) return;
            setErrors({});
            setStep(step + 1);
          }}
        >
          Next
        </Button>
      ) : (
        <Button
          variant="primary"
          data-testid="wizard-save"
          loading={create.isPending || patch.isPending}
          disabled={blockedOrgLevel}
          onClick={submit}
        >
          {editing ? 'Save changes' : 'Create automation'}
        </Button>
      )}
    </>
  );

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      size="xl"
      title={editing ? `Edit "${editing.name}"` : 'New automation'}
      description="Choose when it runs, what it does, then fill in the details."
      footer={footer}
    >
      <div data-testid="schedule-wizard">
        {header}
        {step === 0 && (
          <div className="flex flex-col gap-4">
            <p className="-mb-2 flex items-center gap-1 text-sm font-medium text-fg">
              When should it run?
              <HelpHint article="automations-and-integrations#triggers" label="About automation triggers">
                The trigger is what starts the automation: a time of day, something happening in a project, an
                intake ticket, a labelled issue or a button you press. A webhook is an action: it is what an
                automation sends.
              </HelpHint>
            </p>
            <TileGrid
              label="Trigger"
              value={s.triggerKind}
              onChange={(v) => {
                const t = ACTION_TILES.find((x) => x.id === s.tile);
                set({
                  triggerKind: v,
                  ...(t?.notWith?.includes(v) ? { tile: 'create_card' as const } : {}),
                  ...(v === 'webhook_in' && s.mapping.length === 0
                    ? {
                        mapping: [
                          { target: 'title', text: '{hook.title}' },
                          { target: 'context', text: '{hook.body}' },
                        ],
                        start: 'draft' as const,
                      }
                    : {}),
                  // An automation for mail starts from the usual mapping: the subject is the title, the text the context.
                  ...(isMailKind(v) && s.mapping.length === 0
                    ? {
                        mapping: [
                          { target: 'title', text: '{email.subject}' },
                          { target: 'context', text: 'From {email.from}:\n\n{email.body}' },
                        ],
                        start: 'draft' as const,
                        dedupe: 'subject_from' as const,
                      }
                    : {}),
                });
              }}
              tiles={TRIGGER_TILES}
              icons={TRIGGER_ICON}
            />
            <TriggerFields
              s={s}
              set={set}
              errors={errors}
              workstations={myWorkstations}
              projects={myProjects}
              isOwner={me?.activeOrg?.role === 'owner'}
            />
          </div>
        )}
        {step === 1 && (
          <div className="flex flex-col gap-3">
            <p className="flex items-center gap-1 text-sm font-medium text-fg">
              What should it do?
              <HelpHint article="automations-and-integrations#actions" label="About automation actions">
                The action is the work done each time the schedule fires, for example creating a card or
                posting an update. Some actions only fit certain triggers.
              </HelpHint>
            </p>
            <TileGrid
              label="Action"
              value={s.tile}
              onChange={(v) => set({ tile: v })}
              tiles={ACTION_TILES}
              icons={ACTION_ICON}
              disabled={tileDisabled}
            />
          </div>
        )}
        {step === 2 && (
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInput
                label="Name"
                value={s.name}
                onChange={(e) => set({ name: e.target.value })}
                error={errors.name}
                maxLength={120}
                autoFocus
              />
              <label className="flex min-h-9 items-center gap-2.5 self-end pb-1 text-base text-fg">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--brand)]"
                  checked={s.enabled}
                  onChange={(e) => set({ enabled: e.target.checked })}
                />
                Enabled
              </label>
            </div>
            <ActionFields
              s={s}
              set={set}
              errors={errors}
              workstations={myWorkstations}
              projects={myProjects}
              workflow={workflow}
              editing={!!editing}
              isManager={isManager}
              mockUi={me?.features?.mockUi ?? false}
            />
            {blockedOrgLevel && (
              <Callout tone="warning" data-testid="org-level-note">
                This automation acts for the whole organization, so only the Owner and Admins can save it.
                Choose a project to tie it to one, or ask an Admin.
              </Callout>
            )}
            <ErrorBox error={create.error ?? patch.error} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

function TriggerFields({
  s,
  set,
  errors,
  workstations,
  projects,
  isOwner,
}: {
  s: WizardState;
  set: (p: Partial<WizardState>) => void;
  errors: Record<string, string>;
  workstations: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; key: string; name: string }>;
  isOwner: boolean;
}) {
  const cardFilters = SCHEDULE_EVENT_TRIGGERS.find((x) => x.id === s.event)?.cardFilters;
  if (s.triggerKind === 'manual')
    return <p className="text-sm text-muted">It never runs by itself. Use "Run now" on its card.</p>;
  const cronFields = (
    <>
      <Select
        label={s.triggerKind === 'issue_labelled' ? 'Check for issues' : 'Runs'}
        value={s.preset}
        onChange={(e) => {
          const p = SCHEDULE_PRESETS.find((x) => x.id === e.target.value);
          set({ preset: e.target.value, ...(p ? { cron: p.cron } : {}) });
        }}
      >
        {SCHEDULE_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
        <option value={CUSTOM_PRESET}>Custom cron expression</option>
      </Select>
      <TextInput
        label="Time zone"
        hint="IANA name, e.g. Africa/Johannesburg"
        value={s.timezone}
        onChange={(e) => set({ timezone: e.target.value })}
        error={errors.timezone}
      />
      {s.preset === CUSTOM_PRESET && (
        <TextInput
          label="Cron expression"
          hint="minute hour day month weekday"
          value={s.cron}
          onChange={(e) => set({ cron: e.target.value })}
          error={errors.cron}
        />
      )}
    </>
  );
  if (s.triggerKind === 'cron') return <div className="grid gap-4 sm:grid-cols-2">{cronFields}</div>;
  if (isMailKind(s.triggerKind)) return <MailTriggerFields s={s} set={set} errors={errors} />;
  if (s.triggerKind === 'webhook_in')
    return <HookTriggerFields s={s} set={set} errors={errors} isOwner={isOwner} />;
  if (s.triggerKind === 'intake_ticket')
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          label="Where from"
          value={s.intakeSource}
          onChange={(e) => set({ intakeSource: e.target.value as WizardState['intakeSource'] })}
          hint="A ticket the BA takes into intake: an issue poll, or a request typed in the intake chat."
        >
          <option value="">Any source</option>
          <option value="issues">Issues (GitHub or Jira)</option>
          <option value="web">The intake chat</option>
        </Select>
      </div>
    );
  if (s.triggerKind === 'event')
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          label="Event"
          value={s.event}
          onChange={(e) => isEventName(e.target.value) && set({ event: e.target.value })}
          hint={SCHEDULE_EVENT_TRIGGERS.find((x) => x.id === s.event)?.hint}
        >
          {SCHEDULE_EVENT_TRIGGERS.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </Select>
        <Select
          label="Only in project"
          value={s.eventProjectId}
          onChange={(e) => set({ eventProjectId: e.target.value })}
          hint="Leave empty for every project you can see."
        >
          <option value="">Any project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.key} {p.name}
            </option>
          ))}
        </Select>
        {cardFilters && (
          <CardEventFilters s={s} set={set} errors={errors} withStage={cardFilters === 'stage'} />
        )}
      </div>
    );
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Select
        label="System"
        value={s.provider}
        onChange={(e) => set({ provider: e.target.value as 'github' | 'jira' })}
      >
        <option value="github">GitHub</option>
        <option value="jira">Jira</option>
      </Select>
      <Select
        label="Polling workstation"
        value={s.workstationId}
        onChange={(e) => set({ workstationId: e.target.value })}
        error={errors.workstationId}
        hint="Its credentials (gh login, Jira token) are used; they never leave it."
      >
        <option value="">Choose a workstation</option>
        {workstations.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </Select>
      <TextInput
        label={s.provider === 'github' ? 'Repository' : 'JQL filter'}
        hint={s.provider === 'github' ? 'owner/repo' : 'e.g. project = WEB AND statusCategory != Done'}
        value={s.labelQuery}
        onChange={(e) => set({ labelQuery: e.target.value })}
        error={errors.labelQuery}
      />
      <TextInput
        label="Label"
        value={s.label}
        onChange={(e) => set({ label: e.target.value })}
        error={errors.label}
      />
      {cronFields}
    </div>
  );
}

/** Workflow, stage and filter of the card events ("a card reaches a stage", "a card is done", "an investigation is reported"). */
function CardEventFilters({
  s,
  set,
  errors,
  withStage,
}: {
  s: WizardState;
  set: (p: Partial<WizardState>) => void;
  errors: Record<string, string>;
  withStage: boolean;
}) {
  const workflows = useWorkflows();
  const latest = new Map<string, NonNullable<typeof workflows.data>[number]>();
  for (const w of workflows.data ?? []) {
    const cur = latest.get(w.definition.key);
    if (!cur || w.definition.version > cur.definition.version) latest.set(w.definition.key, w);
  }
  const chosen = latest.get(s.eventWorkflowKey)?.definition;
  return (
    <>
      <Select
        label="Workflow"
        value={s.eventWorkflowKey}
        onChange={(e) => set({ eventWorkflowKey: e.target.value, eventStageId: '', filterCardType: '' })}
        error={errors.eventWorkflowKey}
        hint={withStage ? undefined : 'Leave empty for cards of any workflow.'}
      >
        <option value="">{withStage ? 'Choose a workflow' : 'Any workflow'}</option>
        {[...latest.values()].map((w) => (
          <option key={w.definition.key} value={w.definition.key}>
            {w.definition.name ?? w.definition.key}
          </option>
        ))}
      </Select>
      {withStage && (
        <Select
          label="Stage reached"
          value={s.eventStageId}
          onChange={(e) => set({ eventStageId: e.target.value })}
          error={errors.eventStageId}
          disabled={!chosen}
        >
          <option value="">Choose a stage</option>
          {(chosen?.stages ?? []).map((st) => (
            <option key={st.id} value={st.id}>
              {st.label || st.id}
            </option>
          ))}
        </Select>
      )}
      <Select
        label="Only card type"
        value={s.filterCardType}
        onChange={(e) => set({ filterCardType: e.target.value })}
      >
        <option value="">Any type</option>
        {(chosen?.cardTypes ?? []).map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </Select>
      <div className="grid grid-cols-2 gap-2">
        <TextInput
          label="Only when field"
          hint="Optional, e.g. constraints"
          value={s.filterField}
          onChange={(e) => set({ filterField: e.target.value })}
        />
        <TextInput
          label="equals"
          value={s.filterEquals}
          onChange={(e) => set({ filterEquals: e.target.value })}
          error={errors.filterEquals}
        />
      </div>
    </>
  );
}

/** Incoming webhook: how often it may be called, and (Owner only) whether its cards may start queued. */
function HookTriggerFields({
  s,
  set,
  errors,
  isOwner,
}: {
  s: WizardState;
  set: (p: Partial<WizardState>) => void;
  errors: Record<string, string>;
  isOwner: boolean;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2" data-testid="hook-trigger-fields">
      <p className="text-sm text-muted sm:col-span-2">
        Saving makes a private web address with a secret in it. You see it once, so copy it then. Whatever the
        caller sends is outside content: it can fill the card through {'{hook.<field>}'} tokens, agents read
        it as information, never as instructions, and the card starts as a draft.
      </p>
      <TextInput
        label="Calls accepted per hour (optional)"
        hint="More are refused. The default is 60."
        inputMode="numeric"
        value={s.hookMaxPerHour}
        onChange={(e) => set({ hookMaxPerHour: e.target.value })}
        error={errors.hookMaxPerHour}
      />
      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          className="mt-1"
          checked={s.hookAllowQueued}
          disabled={!isOwner}
          onChange={(e) => set({ hookAllowQueued: e.target.checked })}
          data-testid="hook-allow-queued"
        />
        <span>
          Let its cards start queued for the agents (without a draft step)
          <span className="block text-xs text-subtle">
            {isOwner ? 'Only when the card is set to start queued.' : 'Only the Owner can allow this.'}
          </span>
        </span>
      </label>
    </div>
  );
}

/** The inbox a mail trigger listens to, and (for new mail) the senders and subject it is limited to. */
function MailTriggerFields({
  s,
  set,
  errors,
}: {
  s: WizardState;
  set: (p: Partial<WizardState>) => void;
  errors: Record<string, string>;
}) {
  const inboxes = useMailInboxes();
  const list = inboxes.data?.inboxes ?? [];
  return (
    <div className="grid gap-4 sm:grid-cols-2" data-testid="mail-trigger-fields">
      <Select
        label="Inbox"
        value={s.inboxId}
        onChange={(e) => set({ inboxId: e.target.value })}
        error={errors.inboxId}
        hint={
          list.length === 0
            ? 'No inbox yet. An Owner or Admin makes one under Organization > E-mail inbox.'
            : 'Mail sent to this inbox address starts the automation.'
        }
      >
        <option value="">Choose an inbox</option>
        {list.map((i) => (
          <option key={i.id} value={i.id}>
            {i.label} ({i.address})
          </option>
        ))}
      </Select>
      {s.triggerKind === 'email_received' && (
        <>
          <TextInput
            label="Only from (optional)"
            hint="Addresses or domains, separated by commas: ana@acme.com, acme.org"
            value={s.mailFrom}
            onChange={(e) => set({ mailFrom: e.target.value })}
            error={errors.mailFrom}
          />
          <TextInput
            label="Subject contains (optional)"
            value={s.mailSubject}
            onChange={(e) => set({ mailSubject: e.target.value })}
            maxLength={200}
          />
        </>
      )}
      {s.triggerKind === 'email_reply' && (
        <p className="text-sm text-muted sm:col-span-2">
          A reply to a mail that became a card is added to that card as a comment, whether or not an
          automation listens. This automation also runs for each reply, for example to ask the CEO to look at
          it.
        </p>
      )}
    </div>
  );
}

/** How an automation's cards are made: the field mapping, the state they start in, and the limits. */
function AutomationCardOptions({
  s,
  set,
  errors,
  isManager,
}: {
  s: WizardState;
  set: (p: Partial<WizardState>) => void;
  errors: Record<string, string>;
  isManager: boolean;
}) {
  return (
    <div
      className="flex flex-col gap-4 rounded-panel border border-line p-3"
      data-testid="automation-card-options"
    >
      <MappingEditor
        rows={s.mapping}
        onChange={(mapping) => set({ mapping })}
        error={errors.mapping}
        mail={isMailKind(s.triggerKind)}
        hook={s.triggerKind === 'webhook_in'}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Select
          label="The card starts as"
          value={isManager ? s.start : 'draft'}
          disabled={!isManager}
          onChange={(e) => set({ start: e.target.value as WizardState['start'] })}
          hint={
            !isManager
              ? 'Members can set up automations that make drafts only.'
              : isMailKind(s.triggerKind)
                ? "Mail starts as a draft. Queued applies only to senders on the Owner's allow-list whose address could be verified."
                : 'A draft waits for the BA or you to specify it. Queued goes straight to the agents.'
          }
        >
          {isManager && <option value="">Queued (the default)</option>}
          <option value="draft">Draft for specifying</option>
          {isManager && <option value="queued">Queued for the agents</option>}
        </Select>
        <TextInput
          label="At most per hour"
          hint="Default 20. More are skipped, with one notice on your desk."
          inputMode="numeric"
          value={s.ratePerHour}
          onChange={(e) => set({ ratePerHour: e.target.value })}
          error={errors.ratePerHour}
        />
        <Select
          label="Repeats"
          value={s.dedupe}
          onChange={(e) => set({ dedupe: e.target.value as WizardState['dedupe'] })}
          hint="Avoid a second card for the same thing."
        >
          <option value="none">Allow</option>
          <option value="thread">
            {isMailKind(s.triggerKind) ? 'One card per conversation' : 'One card per source card or ticket'}
          </option>
          <option value="subject_from">One card per title</option>
        </Select>
      </div>
    </div>
  );
}

function ProjectSelect({
  s,
  set,
  projects,
  errors,
  optional,
  isManager,
}: {
  s: WizardState;
  set: (p: Partial<WizardState>) => void;
  projects: Array<{ id: string; key: string; name: string }>;
  errors: Record<string, string>;
  optional?: string;
  isManager: boolean;
}) {
  return (
    <Select
      label={optional ? 'Project (optional)' : 'Project'}
      value={s.projectId}
      onChange={(e) => set({ projectId: e.target.value })}
      error={errors.projectId}
      hint={
        optional
          ? isManager
            ? optional
            : 'Choose a project: only the Owner and Admins can make a schedule for the whole organization.'
          : undefined
      }
    >
      <option value="">{optional ? 'Whole organization' : 'Choose a project'}</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.key} {p.name}
        </option>
      ))}
    </Select>
  );
}

function ActionFields({
  s,
  set,
  errors,
  workstations,
  projects,
  workflow,
  editing,
  isManager,
  mockUi,
}: {
  s: WizardState;
  set: (p: Partial<WizardState>) => void;
  errors: Record<string, string>;
  workstations: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; key: string; name: string }>;
  workflow: Parameters<typeof CardFormFields>[0]['workflow'] | undefined;
  editing: boolean;
  isManager: boolean;
  mockUi: boolean;
}): ReactNode {
  const lockedProject = editing && (s.tile === 'create_card' || s.tile === 'regression_run');
  const ws = (
    <Select
      label="Workstation"
      value={s.workstationId}
      onChange={(e) => set({ workstationId: e.target.value })}
      error={errors.workstationId}
      hint="One of yours: the action runs as you, on your machine."
    >
      <option value="">Choose a workstation</option>
      {workstations.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </Select>
  );
  switch (s.tile) {
    case 'create_card':
      return (
        <>
          <div className={lockedProject ? 'pointer-events-none opacity-70' : undefined}>
            <ProjectSelect s={s} set={set} projects={projects} errors={errors} isManager={isManager} />
          </div>
          {!s.projectId && <p className="text-sm text-muted">Choose a project to fill in the card.</p>}
          {s.projectId && !workflow && (
            <p className="text-sm text-muted">Loading the project's card form...</p>
          )}
          {workflow && (
            <div className="flex flex-col gap-4" data-testid="card-template">
              {workflow.cardTypes.length > 1 && (
                <Select
                  label="Card type"
                  value={s.card.cardType}
                  onChange={(e) => set({ card: { ...s.card, cardType: e.target.value } })}
                  error={errors['card.cardType']}
                >
                  {workflow.cardTypes.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              )}
              <CardFormFields
                workflow={workflow}
                values={s.card}
                onChange={(card) => set({ card })}
                errors={Object.fromEntries(
                  Object.entries(errors)
                    .filter(([k]) => k.startsWith('card.'))
                    .map(([k, v]) => [k.slice(5), v]),
                )}
                repos={[]}
                mockUi={mockUi}
                template
              />
              <p className="text-xs text-subtle">
                Use {'{date}'} or {'{week}'} in the title; without them the date is added.
              </p>
              {isReactiveKind(s.triggerKind) && (
                <AutomationCardOptions s={s} set={set} errors={errors} isManager={isManager} />
              )}
            </div>
          )}
        </>
      );
    case 'regression_run':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <ProjectSelect s={s} set={set} projects={projects} errors={errors} isManager={isManager} />
          <Select
            label="Platform"
            value={s.platform}
            onChange={(e) => set({ platform: e.target.value as WizardState['platform'] })}
          >
            <option value="web">Web</option>
            <option value="mobile">Mobile</option>
            <option value="both">Both</option>
          </Select>
        </div>
      );
    case 'devops_request':
      return (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {ws}
            <label className="flex min-h-9 items-center gap-2.5 self-end pb-1 text-base text-fg">
              <input
                type="checkbox"
                className="size-4 accent-[var(--brand)]"
                checked={s.hygiene}
                onChange={(e) => set({ hygiene: e.target.checked })}
              />
              Repository hygiene run (organization-wide)
            </label>
          </div>
          {!s.hygiene && (
            <TextArea
              label="Request"
              rows={4}
              value={s.devopsText}
              onChange={(e) => set({ devopsText: e.target.value })}
              error={errors.devopsText}
              maxLength={2000}
            />
          )}
          <ProjectSelect
            s={s}
            set={set}
            projects={projects}
            errors={errors}
            optional="Whole organization (Owner and Admins only)"
            isManager={isManager}
          />
        </div>
      );
    case 'ba_task':
      return (
        <div className="flex flex-col gap-4">
          <TextArea
            label="Instructions for the BA"
            hint="The BA only reads: the ledger, the desk, the vault and the repositories. Use {date} and {week} if you like."
            rows={5}
            value={s.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
            error={errors.prompt}
            maxLength={2000}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <ProjectSelect
              s={s}
              set={set}
              projects={projects}
              errors={errors}
              optional="Whole organization (Owner and Admins only)"
              isManager={isManager}
            />
            <Select
              label="Deliver the report"
              value={s.deliver}
              onChange={(e) => set({ deliver: e.target.value as WizardState['deliver'] })}
            >
              <option value="desk_notice">As a notice on the desk</option>
              <option value="chat">On the desk, with the BA chat open for questions</option>
            </Select>
          </div>
        </div>
      );
    case 'github':
    case 'jira':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          {ws}
          <TextInput
            label={s.tile === 'github' ? 'Repository' : 'JQL filter'}
            hint={s.tile === 'github' ? 'owner/repo' : 'e.g. project = WEB AND statusCategory != Done'}
            value={s.query}
            onChange={(e) => set({ query: e.target.value })}
            error={errors.query}
          />
          <ProjectSelect
            s={s}
            set={set}
            projects={projects}
            errors={errors}
            optional="Whole organization (Owner and Admins only)"
            isManager={isManager}
          />
          <p className="text-sm text-muted sm:col-span-2">
            Each new issue becomes an intake conversation with the BA. An issue is taken once.
          </p>
        </div>
      );
    case 'webhook':
      return (
        <div className="flex flex-col gap-4">
          <TextInput
            label="URL"
            hint="https://hooks.slack.com/..., a Teams workflow URL, an n8n or Zapier catch hook"
            value={s.url}
            onChange={(e) => set({ url: e.target.value })}
            error={errors.url}
            inputMode="url"
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="Format"
              value={s.format}
              onChange={(e) => set({ format: e.target.value as WizardState['format'] })}
            >
              {WEBHOOK_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {WEBHOOK_FORMAT_LABEL[f]}
                </option>
              ))}
            </Select>
            <Select
              label="Add a digest"
              value={s.digest}
              onChange={(e) => set({ digest: e.target.value as WizardState['digest'] })}
            >
              <option value="">No digest</option>
              <option value="floor_report">Daily report (the day's facts)</option>
              <option value="project_summary">Project summary</option>
            </Select>
          </div>
          <TextArea
            label="Message"
            hint="Placeholders: {event}, {ref}, {project}, {date}, {issue}. Empty: a one-line summary of the run."
            rows={3}
            value={s.message}
            onChange={(e) => set({ message: e.target.value })}
            maxLength={2000}
          />
          <ProjectSelect
            s={s}
            set={set}
            projects={projects}
            errors={errors}
            optional="Whole organization (Owner and Admins only)"
            isManager={isManager}
          />
          <p className="text-sm text-muted">
            Every request is signed: <code>X-Guildwise-Signature</code> is <code>sha256=</code> and the HMAC of{' '}
            <code>timestamp.body</code> with the schedule's secret, which is shown once after you create it
            (<code>X-AOM-Signature</code> is still sent with the same value until October 2027). A
            failed delivery is retried up to five times.
          </p>
        </div>
      );
    case 'email':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Digest"
            value={s.emailDigest}
            onChange={(e) => set({ emailDigest: e.target.value as WizardState['emailDigest'] })}
          >
            <option value="floor_report">Daily report (the day's facts)</option>
            <option value="project_summary">Project summary</option>
          </Select>
          {s.emailDigest === 'project_summary' && (
            <ProjectSelect s={s} set={set} projects={projects} errors={errors} isManager={isManager} />
          )}
          <TextInput
            label="To"
            hint={isManager ? 'One or more addresses, separated by commas.' : 'Your own address only.'}
            value={s.to}
            onChange={(e) => set({ to: e.target.value })}
            error={errors.to}
            placeholder="me@example.com"
          />
          <TextInput
            label="Subject"
            hint="Empty: the digest's own subject."
            value={s.subject}
            onChange={(e) => set({ subject: e.target.value })}
            maxLength={200}
          />
          <p className="text-sm text-muted sm:col-span-2">
            Sent from the server's mail account. Interest digests join here once interests move to the
            organization.
          </p>
        </div>
      );
  }
}
