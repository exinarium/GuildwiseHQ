import type { CeoStatusDto } from '@aom/shared';
import { useState } from 'react';
import { useDisableCeo, usePauseCeo, useResumeCeo } from '../../api/queries/ceo.ts';
import { money } from '../../lib/money.ts';
import { formatDateTime } from '../../lib/time.ts';
import { AgentAvatar } from '../Face.tsx';
import { Badge, Button, Callout, ConfirmDialog, ErrorBox, Panel } from '../ui.tsx';
import { AppointForm } from './AppointForm.tsx';
import { TrainingBlock } from './TrainingBlock.tsx';

const STATE: Record<CeoStatusDto['state'], { label: string; tone: 'green' | 'amber' | 'red' | 'neutral' }> = {
  none: { label: 'Not appointed', tone: 'neutral' },
  active: { label: 'Active', tone: 'green' },
  paused: { label: 'Paused', tone: 'amber' },
  offline: { label: 'Offline', tone: 'red' },
  disabled: { label: 'Disabled', tone: 'neutral' },
};

function Stat({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: string;
  sub?: string;
  testId?: string;
}) {
  return (
    <div
      className="rounded-card border border-line bg-surface p-3"
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <p className="text-xs text-muted">{label}</p>
      <p className="tnum text-lg font-semibold text-fg">{value}</p>
      {sub && <p className="text-xs text-subtle">{sub}</p>}
    </div>
  );
}

export function OverviewTab({
  status: s,
  owner,
  appointOpen,
}: {
  status: CeoStatusDto;
  owner: boolean;
  appointOpen: boolean;
}) {
  const pause = usePauseCeo();
  const resume = useResumeCeo();
  const disable = useDisableCeo();
  const [confirmDisable, setConfirmDisable] = useState(false);

  if (!s.hired || !s.agent || s.state === 'none')
    return (
      <div className="flex flex-col gap-4">
        <Panel title="A chief executive for your agents">
          <div className="flex flex-col gap-2 text-base text-muted">
            <p>
              The CEO is an agent that works the desk and the floor for you: it answers agent questions, keeps
              cards moving, and writes you a daily report. It decides only what your policy allows, and every
              decision can be undone.
            </p>
            <p>
              It starts in a training period: it recommends, you decide, and it learns from the difference.
              Hiring and other staffing changes stay recommendations until you graduate it.
            </p>
          </div>
        </Panel>
        <AppointForm status={s} owner={owner} open={appointOpen} />
      </div>
    );

  const st = STATE[s.state];
  const a = s.agent;
  const cur = s.spend.currency;
  const share =
    s.spend.orgMonthMicros > 0 ? Math.round((s.spend.monthMicros / s.spend.orgMonthMicros) * 100) : 0;
  const undoRate = s.undone7d.decided > 0 ? s.undone7d.undone / s.undone7d.decided : 0;
  const paused = s.state === 'paused';

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <div className="flex flex-wrap items-center gap-4">
          <AgentAvatar
            agentId={a.id}
            name={a.name}
            size={56}
            seed={a.avatarSeed}
            style={a.avatarStyle as 'notionists'}
          />
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold text-fg" data-testid="ceo-name">
              {a.name}
            </p>
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
              <Badge tone={st.tone} data-testid="ceo-state">
                {st.label}
              </Badge>
              <span>
                on {a.workstationName ?? 'no workstation'} · {a.runtime} · {a.model}
              </span>
            </p>
            {s.state === 'offline' && s.offlineReason && (
              <p className="mt-1 text-sm text-danger" data-testid="ceo-offline-reason">
                {s.offlineReason}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {s.canPause && s.state !== 'disabled' && (
              <Button
                loading={pause.isPending || resume.isPending}
                onClick={() => (paused ? resume.mutate() : pause.mutate({}))}
                data-testid={paused ? 'ceo-resume' : 'ceo-pause'}
              >
                {paused ? 'Resume' : 'Pause'}
              </Button>
            )}
            {owner && s.state !== 'disabled' && (
              <Button
                variant="danger-ghost"
                onClick={() => setConfirmDisable(true)}
                data-testid="ceo-disable"
              >
                Disable
              </Button>
            )}
          </div>
        </div>
        <ErrorBox error={pause.error ?? resume.error ?? disable.error} />
      </Panel>

      {s.state === 'disabled' && (
        <>
          <Callout tone="warning" role="note">
            The CEO is disabled. Your memories, tasks and history are kept.
          </Callout>
          <AppointForm status={s} owner={owner} open={false} />
        </>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Pending wakes" value={String(s.pendingWakes)} testId="ceo-wakes" />
        <Stat
          label="Running shift"
          value={s.running ? s.running.purpose : 'None'}
          {...(s.running ? { sub: `since ${formatDateTime(s.running.since)}` } : {})}
        />
        <Stat label="Open tasks" value={String(s.openTasks)} />
        <Stat label="Last report" value={s.lastReportAt ? formatDateTime(s.lastReportAt) : 'None yet'} />
        <Stat label="Spend today" value={money(s.spend.todayMicros, cur)} testId="ceo-spend-today" />
        <Stat
          label="Spend this month"
          value={money(s.spend.monthMicros, cur)}
          {...(s.spend.orgMonthMicros > 0 ? { sub: `${share}% of the organization's spend` } : {})}
          testId="ceo-spend-month"
        />
        <Stat
          label="Decisions undone, 7 days"
          value={`${s.undone7d.undone} of ${s.undone7d.decided}`}
          testId="ceo-undone"
        />
        <Stat label="Policy version" value={String(s.policyVersion)} />
      </div>

      {undoRate > 0.2 && (
        <Callout tone="warning" role="note" data-testid="ceo-undo-hint">
          You undid more than a fifth of what the CEO decided this week. Consider tightening its policy on the
          Authority tab.
        </Callout>
      )}

      <TrainingBlock status={s} owner={owner} />

      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title="Disable the CEO?"
        description="It stops waking and handling the desk. Your memories, tasks and the activity log are kept."
        confirmLabel="Disable"
        pending={disable.isPending}
        onConfirm={() => disable.mutate(undefined, { onSuccess: () => setConfirmDisable(false) })}
      />
    </div>
  );
}
