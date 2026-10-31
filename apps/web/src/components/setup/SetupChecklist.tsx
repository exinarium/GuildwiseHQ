import type { SetupChecklist, SetupStep } from '@aom/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Circle, ListChecks } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useMe } from '../../api/queries/auth.ts';
import { setupKey, useSetChecklistDismissed, useSetupChecklist } from '../../api/queries/setup.ts';
import { cx } from '../ui/cx.ts';
import { Button, Dialog } from '../ui.tsx';

interface SetupUi {
  data: SetupChecklist | undefined;
  /** The list is open on screen. */
  open: boolean;
  setOpen: (o: boolean) => void;
  /** Unhide the checklist and open it (Help, "Get started"). */
  show: () => void;
  hide: () => void;
}

const NONE: SetupUi = {
  data: undefined,
  open: false,
  setOpen: () => undefined,
  show: () => undefined,
  hide: () => undefined,
};
const Ctx = createContext<SetupUi>(NONE);
export const useSetupChecklistUi = (): SetupUi => useContext(Ctx);

/** Loads the checklist for signed-in organization members and offers the open/hide controls to the shell and Help. */
export function SetupChecklistProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const orgId = me.data?.activeOrg?.id;
  const q = useSetupChecklist(!!orgId);
  const dismiss = useSetChecklistDismissed();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  // Doing a step happens on another page: look again after every navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: route changes only
  useEffect(() => {
    if (orgId) void qc.invalidateQueries({ queryKey: setupKey });
  }, [pathname, orgId]);
  const value = useMemo<SetupUi>(
    () => ({
      data: orgId ? q.data : undefined,
      open,
      setOpen,
      show: () => {
        dismiss.mutate(false);
        setOpen(true);
      },
      hide: () => {
        setOpen(false);
        dismiss.mutate(true);
      },
    }),
    [orgId, q.data, open, dismiss],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <SetupChecklistDialog />
    </Ctx.Provider>
  );
}

/** The steps that count: recommended (optional) steps are shown but never counted. */
export const requiredSteps = (c: SetupChecklist): SetupStep[] => c.steps.filter((s) => !s.optional);

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const numberWord = (n: number): string => NUMBER_WORDS[n] ?? String(n);
const capitalize = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

const SHORT_NAME: Record<string, string> = {
  project: 'project',
  repository: 'repository',
  workstation: 'workstation',
  team: 'team',
  ba: 'the business analyst',
  knowledge: 'Knowledge',
  rules: 'Rules & decisions',
  connections: 'connections',
};

/** "a, b and c". */
const listJoin = (items: string[]): string =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

const GO_LABEL: Record<string, string> = {
  workstation: 'Add',
  team: 'Hire',
  ba: 'Talk',
  knowledge: 'Add',
  rules: 'Add',
  connections: 'Connect',
};

/** Whether the sidebar button shows: there are steps, the user did not hide it, and the setup is not finished. */
export const checklistVisible = (c: SetupChecklist | undefined): c is SetupChecklist =>
  !!c && c.steps.length > 0 && !c.dismissed && !c.complete;

/** The sidebar button: "Get started 2/5" with a thin progress bar. Opens the list. */
export function SetupWidget({ collapsed = false }: { collapsed?: boolean }) {
  const { data, open, setOpen } = useSetupChecklistUi();
  if (!checklistVisible(data)) return null;
  const total = requiredSteps(data).length;
  const label = `Get started: ${data.doneCount} of ${total} steps done`;
  return (
    <button
      type="button"
      data-tour="setup-checklist"
      data-testid="setup-widget"
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={label}
      onClick={() => setOpen(true)}
      className={cx(
        'flex items-center gap-2 rounded-control border border-side-line text-sm font-medium text-side-fg hover:bg-side-hover hover:text-side-strong',
        collapsed ? 'mx-auto size-10 justify-center' : 'h-10 w-full px-3 [@media(pointer:coarse)]:h-11',
      )}
    >
      <ListChecks aria-hidden="true" className="size-4 shrink-0" />
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate text-left">Get started</span>
          <span className="tnum text-xs" data-testid="setup-widget-count">
            {data.doneCount}/{total}
          </span>
        </>
      )}
    </button>
  );
}

function StepRow({ step, onGo }: { step: SetupStep; onGo: () => void }) {
  const missing = step.missing?.length ? `Still to hire: ${step.missing.join(', ')}.` : null;
  return (
    <li className="flex items-start gap-3 py-3" data-testid={`setup-step-${step.id}`} data-done={step.done}>
      <span
        className={cx(
          'mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full',
          step.done ? 'bg-success-soft text-success-soft-fg' : 'border border-control text-subtle',
        )}
      >
        {step.done ? (
          <Check aria-hidden="true" className="size-4" />
        ) : (
          <Circle aria-hidden="true" className="size-3" />
        )}
        <span className="sr-only">{step.done ? 'Done' : 'Not done yet'}</span>
      </span>
      <div className="min-w-0 flex-1">
        <p className={cx('text-sm font-medium', step.done ? 'text-muted line-through' : 'text-fg')}>
          {step.title}
          {step.optional && (
            <span
              className="ml-2 rounded-full bg-sunken px-2 py-0.5 align-middle text-xs font-normal text-muted no-underline"
              data-testid={`setup-optional-${step.id}`}
            >
              Recommended
            </span>
          )}
        </p>
        <p className="text-sm text-muted">{step.hint}</p>
        {!step.done && missing && <p className="text-sm text-muted">{missing}</p>}
        {!step.done && !step.actionable && (
          <p className="text-sm text-subtle" data-testid={`setup-readonly-${step.id}`}>
            An Owner or Admin does this step.
          </p>
        )}
      </div>
      {!step.done && step.link && (
        <Link
          to={step.link}
          onClick={onGo}
          data-testid={`setup-go-${step.id}`}
          className="inline-flex h-8 shrink-0 items-center rounded-control border border-control bg-surface px-3 text-sm font-medium text-fg hover:bg-sunken"
        >
          {GO_LABEL[step.id] ?? 'Start'}
        </Link>
      )}
    </li>
  );
}

/** The whole list, as a dialog opened from the sidebar button or from Help. */
export function SetupChecklistDialog() {
  const { data, open, setOpen, hide } = useSetupChecklistUi();
  if (!data || data.steps.length === 0) return null;
  const total = requiredSteps(data).length;
  const pct = total ? Math.round((data.doneCount / total) * 100) : 0;
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Get started"
      description={
        data.complete
          ? 'Everything is set up. Your team can take cards now.'
          : `${capitalize(numberWord(total))} steps from an empty organization to a team that works. Each one ticks itself off.`
      }
      footer={
        <>
          {!data.complete && !data.dismissed && (
            <Button variant="secondary" onClick={hide} data-testid="setup-hide">
              Hide this checklist
            </Button>
          )}
          <Button variant="primary" onClick={() => setOpen(false)}>
            Close
          </Button>
        </>
      }
    >
      <div data-testid="setup-checklist">
        <div
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={data.doneCount}
          className="h-1.5 overflow-hidden rounded-full bg-sunken"
        >
          <div className="h-full bg-brand transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <ul className="mt-1 divide-y divide-line">
          {data.steps.map((s) => (
            <StepRow key={s.id} step={s} onGo={() => setOpen(false)} />
          ))}
        </ul>
        <p className="mt-2 text-sm text-subtle">You can bring this back any time from the Help page.</p>
      </div>
    </Dialog>
  );
}

/** The card on the Help page: progress and a button to open the list (also when it was hidden). */
export function SetupHelpCard() {
  const { data, show, setOpen } = useSetupChecklistUi();
  if (!data || data.steps.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3" data-testid="help-setup">
      <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-soft-fg">
        <ListChecks aria-hidden="true" className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold text-fg">The Get started checklist</h2>
        <p className="text-sm text-muted">
          {data.complete
            ? `All ${numberWord(requiredSteps(data).length)} steps are done.`
            : `${data.doneCount} of ${requiredSteps(data).length} steps done: ${listJoin(requiredSteps(data).map((x) => SHORT_NAME[x.id] ?? x.id))}.`}
        </p>
      </div>
      <Button
        variant="primary"
        onClick={data.dismissed ? show : () => setOpen(true)}
        data-testid="help-open-setup"
      >
        {data.dismissed ? 'Show the checklist' : 'Open the checklist'}
      </Button>
    </div>
  );
}
