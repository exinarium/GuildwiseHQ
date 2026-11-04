import { SHIFT_LIMIT_SOURCE_LABEL, type WorkstationDto } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useSetShiftLimit } from '../../api/queries/workstations.ts';
import { Button, ErrorBox, Select, TextInput, useToast } from '../ui.tsx';

type Mode = 'default' | 'number' | 'unlimited';

const modeOf = (s: NonNullable<WorkstationDto['shifts']>['setting']): Mode =>
  s === null ? 'default' : s === 'unlimited' ? 'unlimited' : 'number';

const UNLIMITED = 100_000;
const limitText = (n: number | null) => (n === null || n >= UNLIMITED ? 'no limit' : String(n));

/**
 * The limit the runner enforces, where it comes from, what counts and who holds the slots (GWP-95). Plain visible text,
 * no hover-only tooltips, so it reads the same on touch devices.
 */
export function ShiftLimitStatus({ w }: { w: WorkstationDto }) {
  const s = w.shifts;
  if (!s) return null;
  // an older server sends none of the GWP-95 fields
  const enforced = s.enforced ?? null;
  const source = s.source ?? null;
  const otherRunning = s.otherRunning ?? 0;
  const shown = enforced ?? (source ? { limit: s.limit, source } : null);
  const full = shown && shown.limit !== null && s.running >= shown.limit;
  const holders = (s.holders ?? [])
    .map((h) => `${h.cardRef ?? h.kind}${h.agentName ? ` (${h.agentName})` : ''}`)
    .join(', ');
  return (
    <div className="mt-1 flex flex-col gap-1 text-xs" data-testid="shift-limit-status">
      {shown && (
        <p className="text-muted" data-testid="shift-limit-effective">
          {shown.limit === null
            ? `${s.running} · no limit · ${SHIFT_LIMIT_SOURCE_LABEL[shown.source]}`
            : `${s.running} of ${shown.limit} · ${SHIFT_LIMIT_SOURCE_LABEL[shown.source]}`}
        </p>
      )}
      {otherRunning > 0 && (
        <p className="text-muted" data-testid="shift-limit-other">
          +{otherRunning} chat/CEO (not counted)
        </p>
      )}
      {full && (
        <p className="text-warning" data-testid="shift-limit-full">
          Full: new shifts wait.{holders ? ` Held by ${holders}.` : ''}
        </p>
      )}
      {s.sync === 'mismatch' && enforced && (
        <p role="status" className="text-warning" data-testid="shift-limit-mismatch">
          The runner enforces {limitText(enforced.limit)} ({SHIFT_LIMIT_SOURCE_LABEL[enforced.source]}), not{' '}
          {s.unlimited ? 'no limit' : limitText(s.limit)} as set here.
        </p>
      )}
      {s.sync === 'unknown' && w.connected && s.supported !== null && source !== null && (
        <p role="status" className="text-warning" data-testid="shift-limit-unknown">
          This runner does not report the limit it enforces: update it.
        </p>
      )}
      {s.sync === 'applying' && (
        <p className="text-muted" data-testid="shift-limit-applying">
          Applying…
        </p>
      )}
    </div>
  );
}

/**
 * How many shifts this workstation runs at once (backlog #76), for its owner: the runner's own value, a number, or
 * unlimited. Says when the platform ceiling is lower than the choice and when the runner is too old to apply it live.
 */
export function ShiftLimit({ w }: { w: WorkstationDto }) {
  const s = w.shifts;
  const toast = useToast();
  const set = useSetShiftLimit(w.id);
  const [mode, setMode] = useState<Mode>(s ? modeOf(s.setting) : 'default');
  const [count, setCount] = useState(typeof s?.setting === 'number' ? String(s.setting) : '');
  const [err, setErr] = useState('');
  if (!s) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    let limit: number | 'unlimited' | null = null;
    if (mode === 'unlimited') limit = 'unlimited';
    if (mode === 'number') {
      const n = Number(count);
      if (!Number.isInteger(n) || n < 1 || n > 10_000)
        return setErr('Enter a whole number from 1 to 10,000, or choose Unlimited');
      limit = n;
    }
    setErr('');
    set.mutate(limit, { onSuccess: () => toast.success('Shift limit saved') });
  };

  const cap = s.platformCap;
  const wanted = s.setting;
  const capped = cap !== null && (wanted === 'unlimited' || (typeof wanted === 'number' && wanted > cap));
  const dirty =
    mode !== modeOf(s.setting) || (mode === 'number' && Number(count) !== (wanted as number | null));

  return (
    <form
      onSubmit={submit}
      aria-label={`Shift limit of ${w.name}`}
      className="mt-3 flex flex-col gap-2"
      noValidate
      data-testid="shift-limit"
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-full sm:w-56">
          <Select
            label="Shifts at once"
            value={mode}
            onChange={(e) => setMode(e.target.value as Mode)}
            hint={s.runnerLimit ? `Runner's own value: ${s.runnerLimit}` : undefined}
          >
            <option value="default">Runner's own value</option>
            <option value="number">A number</option>
            <option value="unlimited">Unlimited</option>
          </Select>
        </div>
        {mode === 'number' && (
          <div className="w-28">
            <TextInput
              label="Number"
              inputMode="numeric"
              value={count}
              onChange={(e) => setCount(e.target.value)}
              error={err}
            />
          </div>
        )}
        <Button type="submit" variant="primary" loading={set.isPending} disabled={!dirty}>
          Save
        </Button>
      </div>
      {mode !== 'number' && err && (
        <p role="alert" className="text-xs text-danger">
          {err}
        </p>
      )}
      <ErrorBox error={set.error} />
      {s.unlimited ? (
        <p className="text-xs text-muted" data-testid="shift-limit-unlimited">
          No limit from Guildwise. The machine's memory and CPU, and the model usage limit, still apply.
        </p>
      ) : (
        mode === 'unlimited' && (
          <p className="text-xs text-muted" data-testid="shift-limit-unlimited-note">
            Unlimited means no limit from Guildwise. The machine's memory and CPU, and the model usage limit,
            still apply.
          </p>
        )
      )}
      {capped && (
        <p role="status" className="text-xs text-warning" data-testid="shift-limit-capped">
          The platform allows at most {cap} shifts per workstation, so {cap} applies, not{' '}
          {wanted === 'unlimited' ? 'unlimited' : wanted}. Only the platform administrator can raise that.
        </p>
      )}
      {s.supported === false && wanted !== null && (
        <p role="status" className="text-xs text-warning" data-testid="shift-limit-old-runner">
          This runner is too old to use the setting: it keeps its own value ({s.runnerLimit ?? 'default'})
          until you update it.
        </p>
      )}
    </form>
  );
}
