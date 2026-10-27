import {
  ACTION_CLASSES,
  type CeoLimits,
  type CeoMode,
  type CeoPolicy,
  type CeoStatusDto,
  clonePolicy,
  isHardNever,
  OWNER_RESERVED_KEYS,
  OWNER_RESERVED_LABEL,
  type OwnerReservedKey,
  withDelegation,
} from '@aom/shared';
import { useEffect, useState } from 'react';
import { useCeoPolicy, useResetCeoPolicy, useSaveCeoPolicy } from '../../api/queries/ceo.ts';
import { classLabel } from '../../lib/ceo.ts';
import { deskKindLabel } from '../../lib/desk.ts';
import { cx } from '../ui/cx.ts';
import { Badge, Button, Callout, ConfirmDialog, ErrorBox, Panel, Spinner, TextInput } from '../ui.tsx';

const MODES: Array<{ value: CeoMode; label: string }> = [
  { value: 'decide', label: 'Decide' },
  { value: 'recommend', label: 'Recommend' },
  { value: 'never', label: 'Never' },
];

const CLASS_NOTE: Partial<Record<string, string>> = {
  'agent.retire': 'Firing: the CEO benches first, then asks you to confirm.',
  'card.cancel': 'Cancelling more than 3 cards at once is always yours.',
  'devops.approve': 'Destructive DevOps actions are listed below as owner-reserved.',
  'memory.write': 'Only things you said or decided.',
};

const LIMIT_FIELDS: Array<{ key: keyof CeoLimits; label: string; min: number; max: number; step?: number }> =
  [
    { key: 'maxHiresPerDay', label: 'Hires per day', min: 0, max: 20 },
    { key: 'maxAgentsPerRolePerProject', label: 'Agents per role per project', min: 1, max: 20 },
    { key: 'maxCeoHiredActive', label: 'Active agents the CEO may have hired', min: 0, max: 50 },
    { key: 'maxActionsPerHour', label: 'Actions per hour', min: 1, max: 500 },
    { key: 'maxMessagesPerAgentPerDay', label: 'Messages per agent per day', min: 0, max: 50 },
    { key: 'maxActionsPerSubjectPerDay', label: 'Actions per card or agent per day', min: 1, max: 50 },
    { key: 'maxWakesPerHour', label: 'Wakes per hour', min: 1, max: 60 },
    { key: 'budgetHeadroom', label: 'Budget headroom for hires (0.1 to 1)', min: 0.1, max: 1, step: 0.05 },
  ];

const deskLabel = (key: string): string => {
  const [kind = '', sub = '*'] = key.split(':');
  return sub === '*' ? `Any ${kind}` : `${kind}: ${deskKindLabel({ kind: kind as 'alert', subkind: sub })}`;
};

function ModeRadios({
  name,
  label,
  value,
  onChange,
  disabled,
}: {
  name: string;
  label: string;
  value: CeoMode;
  onChange: (m: CeoMode) => void;
  disabled: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-x-4 gap-y-1">
      {MODES.map((m) => (
        <label
          key={m.value}
          className={cx(
            'inline-flex items-center gap-1.5 text-sm',
            disabled ? 'text-disabled-fg' : 'text-fg',
          )}
        >
          <input
            type="radio"
            name={name}
            value={m.value}
            checked={value === m.value}
            disabled={disabled}
            onChange={() => onChange(m.value)}
            className="size-4"
            aria-label={`${label}: ${m.label}`}
          />
          <span aria-hidden="true">{m.label}</span>
        </label>
      ))}
    </div>
  );
}

/** The Authority tab: what the CEO may decide, recommend or never do (the server decides, the prompt does not). */
export function AuthorityTab({ status }: { status: CeoStatusDto }) {
  const q = useCeoPolicy();
  const save = useSaveCeoPolicy();
  const reset = useResetCeoPolicy();
  const [draft, setDraft] = useState<CeoPolicy | null>(null);
  const [delegating, setDelegating] = useState<OwnerReservedKey | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const version = q.data?.policy.version;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new saved version replaces the draft
  useEffect(() => {
    if (q.data) setDraft(clonePolicy(q.data.policy));
  }, [version]);

  if (q.isPending) return <Spinner label="Loading the policy" />;
  if (!q.data || !draft) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const canEdit = q.data.canEdit;
  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data.policy);
  const setClass = (c: string, mode: CeoMode) =>
    setDraft((d) => {
      if (!d) return d;
      const n = clonePolicy(d);
      n.classes[c] = { mode };
      return n;
    });
  const setDesk = (k: string, mode: CeoMode) =>
    setDraft((d) => (d ? { ...d, desk: { ...d.desk, [k]: mode } } : d));
  const setLimit = (k: keyof CeoLimits, v: number) =>
    setDraft((d) => (d ? { ...d, limits: { ...d.limits, [k]: v } } : d));
  const rows = ACTION_CLASSES.filter((c) => !isHardNever(c));

  return (
    <div className="flex flex-col gap-4" data-testid="ceo-authority">
      {!canEdit && (
        <Callout tone="info" role="note" data-testid="ceo-authority-readonly">
          Only the Owner can change the CEO's authority. You can read it here.
        </Callout>
      )}

      <Panel title="What the CEO may do" padding="none">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Authority by kind of action</caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="px-4 py-2 font-medium">
                  Action
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Mode
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Note
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((c) => {
                return (
                  <tr key={c} data-testid={`ceo-class-${c}`}>
                    <th scope="row" className="px-4 py-2 font-medium text-fg">
                      {classLabel(c)}
                    </th>
                    <td className="px-4 py-2">
                      <ModeRadios
                        name={`class-${c}`}
                        label={classLabel(c)}
                        value={draft.classes[c]?.mode ?? 'recommend'}
                        onChange={(m) => setClass(c, m)}
                        disabled={!canEdit}
                      />
                    </td>
                    <td className="px-4 py-2 text-xs text-muted">
                      {CLASS_NOTE[c] && <span className="block">{CLASS_NOTE[c]}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Owner-reserved matters">
        <p className="mb-3 text-sm text-muted">
          These always come to you as a recommendation, unless you delegate one. Delegating names the risk and
          asks you to confirm.
        </p>
        <ul className="divide-y divide-line" data-testid="ceo-reserved">
          {OWNER_RESERVED_KEYS.map((k) => {
            const on = draft.delegated.includes(k);
            return (
              <li key={k} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-sm text-fg">
                  {OWNER_RESERVED_LABEL[k]}{' '}
                  <Badge tone={on ? 'amber' : 'neutral'}>{on ? 'Delegated to the CEO' : 'You decide'}</Badge>
                </span>
                {canEdit &&
                  (on ? (
                    <Button
                      size="sm"
                      onClick={() => setDraft((d) => (d ? withDelegation(d, k, false) : d))}
                      aria-label={`Take back: ${OWNER_RESERVED_LABEL[k]}`}
                    >
                      Take back
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => setDelegating(k)}
                      aria-label={`Delegate: ${OWNER_RESERVED_LABEL[k]}`}
                    >
                      Delegate...
                    </Button>
                  ))}
              </li>
            );
          })}
        </ul>
      </Panel>

      <Panel title="Items on the desk">
        <p className="mb-3 text-sm text-muted">
          How the CEO treats each kind of desk item. The most specific line wins.
        </p>
        <ul className="divide-y divide-line" data-testid="ceo-desk-map">
          {Object.keys(draft.desk)
            .sort()
            .map((k) => (
              <li key={k} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-sm text-fg">{deskLabel(k)}</span>
                <ModeRadios
                  name={`desk-${k}`}
                  label={`Desk ${deskLabel(k)}`}
                  value={draft.desk[k] ?? 'recommend'}
                  onChange={(m) => setDesk(k, m)}
                  disabled={!canEdit}
                />
              </li>
            ))}
        </ul>
      </Panel>

      <Panel title="Confidence and limits">
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
            Minimum confidence to decide: {Math.round(draft.minConfidence * 100)}%
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={draft.minConfidence}
              disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, minConfidence: Number(e.target.value) })}
              data-testid="ceo-min-confidence"
              className="w-full max-w-md"
            />
            <span className="text-xs font-normal text-subtle">
              Below this the CEO recommends instead of deciding.
            </span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {LIMIT_FIELDS.map((f) => (
              <TextInput
                key={f.key}
                label={f.label}
                type="number"
                inputMode="decimal"
                min={f.min}
                max={f.max}
                step={f.step ?? 1}
                disabled={!canEdit}
                value={String(draft.limits[f.key])}
                onChange={(e) => setLimit(f.key, Number(e.target.value))}
              />
            ))}
          </div>
        </div>
      </Panel>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!dirty}
            onClick={() => save.mutate({ policy: draft })}
            data-testid="ceo-policy-save"
          >
            Save
          </Button>
          <Button onClick={() => setConfirmReset(true)}>Reset to defaults</Button>
          <span className="text-sm text-muted" data-testid="ceo-policy-version">
            Policy version {q.data.policy.version}
          </span>
        </div>
      )}
      {!canEdit && (
        <p className="text-sm text-muted" data-testid="ceo-policy-version">
          Policy version {q.data.policy.version}
        </p>
      )}
      <ErrorBox error={save.error ?? reset.error} />

      <ConfirmDialog
        open={delegating !== null}
        onOpenChange={(o) => !o && setDelegating(null)}
        title="Delegate this to the CEO?"
        confirmLabel="Delegate"
        pending={save.isPending}
        onConfirm={() => {
          if (!delegating) return;
          save.mutate(
            { policy: withDelegation(draft, delegating, true), confirmDelegation: true },
            { onSuccess: () => setDelegating(null) },
          );
        }}
      >
        {delegating && (
          <div className="flex flex-col gap-2 text-sm text-muted" data-testid="ceo-delegate-dialog">
            <p className="font-medium text-fg">{OWNER_RESERVED_LABEL[delegating]}</p>
            <p>
              The CEO will decide this without asking you, within its limits and minimum confidence. A wrong
              decision here can cost money, reach people outside the organization, or be impossible to undo.
              You can take it back at any time, but not what was already done.
            </p>
          </div>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset the policy to the defaults?"
        description="Every mode, limit and delegation goes back to the defaults. This becomes a new policy version."
        confirmLabel="Reset"
        pending={reset.isPending}
        onConfirm={() => reset.mutate(undefined, { onSuccess: () => setConfirmReset(false) })}
      />
    </div>
  );
}
