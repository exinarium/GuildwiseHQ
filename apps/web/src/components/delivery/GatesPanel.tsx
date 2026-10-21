import type { Gate, GatePresetDto } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useGates, useRemovePreset, useSetBinding, useSetPreset } from '../../api/queries/delivery.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { Badge, Button, Callout, Disclosure, ErrorBox, Panel, Select, TextInput } from '../ui.tsx';
import { describeGate } from './gate-text.ts';

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
    <div data-testid="gates-panel">
      <h2 className="mb-1 text-lg font-semibold text-fg">Rule sets</h2>
      <p className="mb-3 text-sm text-muted">
        A rule set says what must be true before a site is released: the test site healthy on the same
        version, tests passed, a time window, a freeze. A site uses a rule set (or has its own); a rule bound
        to a project always applies on top. Who releases is decided in the setup the Owner approves.
      </p>
      <ul className="mb-4 flex flex-col divide-y divide-line text-sm" data-testid="gate-presets">
        {presets.length === 0 && <li className="py-2 text-subtle">No rule set yet.</li>}
        {presets.map((p) => (
          <li key={p.name} className="flex flex-wrap items-center gap-2 py-2">
            <span className="font-medium">{p.name}</span>
            {p.gate.freeze && <Badge tone="danger">frozen</Badge>}
            <span className="min-w-0 flex-1 text-xs text-muted">
              {describeGate(p.gate).join('; ') || 'No extra rules'}
            </span>
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
          label="Name of the rule set"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="standard"
        />
        <TextInput
          label="The test site that must be healthy first (its short name)"
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
            Save rule set
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
        A bound rule is added to the site's own rules: a site cannot loosen it.
      </Callout>
      <ErrorBox error={q.error ?? setPreset.error ?? remove.error ?? bind.error} />
    </div>
  );
}

/**
 * Rules (docs/design/environments-ux.md section 5.5): what must be true before a release, in sentences. A freeze stops every
 * release. The raw rule-set editor sits behind "Advanced".
 */
export function RulesPanel({ canEdit }: { canEdit: boolean }) {
  const q = useGates();
  const projects = useProjects();
  const setPreset = useSetPreset();
  const presets = q.data?.presets ?? [];
  const bindings = q.data?.bindings ?? [];
  const bound = bindings
    .map((b) => ({ b, preset: presets.find((p) => p.name === b.preset) }))
    .filter((x) => x.preset);
  const targets =
    bound.length > 0 ? [...new Set(bound.map((x) => x.preset?.name))] : presets.map((p) => p.name);
  const frozen =
    presets.length > 0 && presets.filter((p) => targets.includes(p.name)).every((p) => p.gate.freeze);
  const toggleFreeze = () => {
    for (const p of presets.filter((x) => targets.includes(x.name)))
      setPreset.mutate({ name: p.name, gate: { ...p.gate, freeze: !frozen } });
  };
  return (
    <div className="flex flex-col gap-4" data-testid="rules-panel">
      <Panel>
        <h2 className="mb-1 text-lg font-semibold text-fg">The standard rule</h2>
        <p className="mb-3 text-sm text-muted">What must be true before a version goes to a live site.</p>
        {q.isPending ? (
          <p className="text-sm text-muted">Loading the rules...</p>
        ) : bound.length === 0 ? (
          <p className="text-sm text-subtle" data-testid="rules-none">
            No standard rule is set. Each site uses the rules written in its own setup.
          </p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="rules-list">
            {bound.map(({ b, preset }) => (
              <li key={b.id} className="text-sm">
                <p className="font-medium text-fg">
                  {projects.data?.find((p) => p.id === b.projectId)?.key ?? 'A repository'}:{' '}
                  {b.envMatch === 'production' ? 'live sites' : 'every site'}
                </p>
                <ul className="mt-1 list-disc pl-5 text-muted">
                  {(preset ? describeGate(preset.gate) : []).map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                  <li>You approve every release</li>
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-fg">Freeze</h2>
            <p className="text-sm text-muted">
              {frozen ? 'Nothing goes live right now.' : 'Releases are allowed when the rules hold.'} While a
              freeze is on, nothing goes live.
            </p>
          </div>
          <Badge tone={frozen ? 'danger' : 'neutral'}>{frozen ? 'Freeze is on' : 'Freeze is off'}</Badge>
          {canEdit && (
            <Button
              onClick={toggleFreeze}
              loading={setPreset.isPending}
              disabled={presets.length === 0}
              data-testid="freeze-toggle"
              className="min-h-11"
            >
              {frozen ? 'Lift the freeze' : 'Freeze all releases'}
            </Button>
          )}
        </div>
        <ErrorBox error={setPreset.error} />
      </Panel>
      {canEdit && (
        <Disclosure summary="Advanced: rule sets" data-testid="rules-advanced">
          <Panel>
            <GatesPanel />
          </Panel>
        </Disclosure>
      )}
    </div>
  );
}
