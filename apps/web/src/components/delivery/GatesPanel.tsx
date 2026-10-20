import type { Gate, GatePresetDto } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useGates, useRemovePreset, useSetBinding, useSetPreset } from '../../api/queries/delivery.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { Badge, Button, Callout, ErrorBox, Panel, Select, TextInput } from '../ui.tsx';

export const describeGate = (g: Gate): string => {
  const parts: string[] = [];
  for (const r of g.requires)
    parts.push(
      'envHealthy' in r
        ? `${r.envHealthy} healthy on the same commit${r.forMinutes ? ` for ${r.forMinutes} min` : ''}`
        : 'checksPassed' in r
          ? `${r.checksPassed} checks passed`
          : 'a done phase',
    );
  if (g.window) parts.push(`only ${g.window.days} ${g.window.hours}`);
  if (g.freeze) parts.push('FROZEN');
  return parts.length ? parts.join(', ') : 'nothing required';
};

/** Gate presets and the standard rule bound to a project (docs/design/ceo-front-door.md 9.3). Who releases is the recipe's decision. */
export function GatesPanel() {
  const q = useGates();
  const projects = useProjects();
  const setPreset = useSetPreset();
  const remove = useRemovePreset();
  const bind = useSetBinding();
  const [name, setName] = useState('');
  const [env, setEnv] = useState('');
  const [minutes, setMinutes] = useState('30');
  const [regression, setRegression] = useState(true);
  const [e2e, setE2e] = useState(false);
  const [phase, setPhase] = useState(false);
  const [days, setDays] = useState('mon-fri');
  const [hours, setHours] = useState('08-16');
  const [useWindow, setUseWindow] = useState(false);
  const [freeze, setFreeze] = useState(false);
  const [bindProject, setBindProject] = useState('');
  const [bindPreset, setBindPreset] = useState('');
  const [bindMatch, setBindMatch] = useState<'production' | '*'>('production');
  const presets = q.data?.presets ?? [];

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const gate: Gate = {
      requires: [
        ...(env.trim()
          ? [
              {
                envHealthy: env.trim(),
                sameCommit: true as const,
                ...(Number(minutes) > 0 ? { forMinutes: Number(minutes) } : {}),
              },
            ]
          : []),
        ...(regression ? [{ checksPassed: 'regression' as const, sameCommit: true as const }] : []),
        ...(e2e ? [{ checksPassed: 'e2e' as const, sameCommit: true as const }] : []),
        ...(phase ? [{ phaseDone: true as const }] : []),
      ],
      ...(useWindow ? { window: { days, hours, tz: 'org' as const } } : {}),
      ...(freeze ? { freeze: true } : {}),
    };
    setPreset.mutate({ name: name.trim(), gate } as { name: string; gate: GatePresetDto['gate'] }, {
      onSuccess: () => setName(''),
    });
  };

  return (
    <Panel data-testid="gates-panel">
      <h2 className="mb-1 text-lg font-semibold text-fg">Gate presets</h2>
      <p className="mb-3 text-sm text-muted">
        A gate says what must be true before an environment is released: an earlier environment healthy on the
        same commit, tests passed, a time window, a freeze. A recipe names a preset (or has its own gate); a
        rule bound to a project always applies on top. Who releases is decided in the recipe, which you
        approve.
      </p>
      <ul className="mb-4 flex flex-col divide-y divide-line text-sm" data-testid="gate-presets">
        {presets.length === 0 && <li className="py-2 text-subtle">No preset yet.</li>}
        {presets.map((p) => (
          <li key={p.name} className="flex flex-wrap items-center gap-2 py-2">
            <span className="font-medium">{p.name}</span>
            {p.gate.freeze && <Badge tone="danger">frozen</Badge>}
            <span className="min-w-0 flex-1 text-xs text-muted">{describeGate(p.gate)}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPreset.mutate({ name: p.name, gate: { ...p.gate, freeze: !p.gate.freeze } })}
            >
              {p.gate.freeze ? 'Lift freeze' : 'Freeze'}
            </Button>
            <Button
              size="sm"
              variant="danger-ghost"
              onClick={() => remove.mutate(p.name)}
              aria-label={`Remove ${p.name}`}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-2" data-testid="gate-form">
        <TextInput
          label="Preset name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="standard"
        />
        <TextInput
          label="An earlier environment must be healthy (name)"
          value={env}
          onChange={(e) => setEnv(e.target.value)}
          placeholder="uat"
        />
        <TextInput
          label="...for this many minutes"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          inputMode="numeric"
        />
        <div className="flex flex-col gap-1.5 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={regression} onChange={(e) => setRegression(e.target.checked)} />{' '}
            Regression run passed
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={e2e} onChange={(e) => setE2e(e.target.checked)} /> Full suite
            (E2E) passed
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={phase} onChange={(e) => setPhase(e.target.checked)} /> The commit
            is a done phase
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={useWindow} onChange={(e) => setUseWindow(e.target.checked)} />{' '}
            Only in a time window
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={freeze} onChange={(e) => setFreeze(e.target.checked)} /> Frozen
          </label>
        </div>
        {useWindow && (
          <>
            <TextInput
              label="Days"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              hint="mon-fri, or mon,wed,fri"
            />
            <TextInput
              label="Hours (your organization time)"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              hint="08-16"
            />
          </>
        )}
        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" loading={setPreset.isPending} disabled={!name.trim()}>
            Save preset
          </Button>
        </div>
      </form>
      <h3 className="mt-5 mb-1 text-base font-semibold text-fg">The standard rule of a project</h3>
      <ul className="mb-2 text-sm" data-testid="gate-bindings">
        {(q.data?.bindings ?? []).map((b) => (
          <li key={b.id} className="flex flex-wrap items-center gap-2 py-1">
            <span>
              {projects.data?.find((p) => p.id === b.projectId)?.key ?? 'a repository'}:{' '}
              {b.envMatch === 'production' ? 'production environments' : 'every environment'} follow{' '}
              <span className="font-medium">{b.preset}</span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                bind.mutate({
                  ...(b.projectId ? { projectId: b.projectId } : { repoId: b.repoId as string }),
                  envMatch: b.envMatch,
                  preset: null,
                })
              }
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <Select label="Project" value={bindProject} onChange={(e) => setBindProject(e.target.value)}>
          <option value="">Choose</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.key}
            </option>
          ))}
        </Select>
        <Select
          label="Applies to"
          value={bindMatch}
          onChange={(e) => setBindMatch(e.target.value as 'production' | '*')}
        >
          <option value="production">production environments</option>
          <option value="*">every environment</option>
        </Select>
        <Select label="Preset" value={bindPreset} onChange={(e) => setBindPreset(e.target.value)}>
          <option value="">Choose</option>
          {presets.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </Select>
        <Button
          disabled={!bindProject || !bindPreset}
          loading={bind.isPending}
          onClick={() => bind.mutate({ projectId: bindProject, envMatch: bindMatch, preset: bindPreset })}
        >
          Bind
        </Button>
      </div>
      <Callout tone="info" className="mt-3">
        A bound rule is added to the recipe's own gate: a recipe cannot loosen it.
      </Callout>
      <ErrorBox error={q.error ?? setPreset.error ?? remove.error ?? bind.error} />
    </Panel>
  );
}
