import type { DeployTargetDto, FollowupSpec, PhaseFollowupDto } from '@aom/shared';
import { Link } from 'react-router';
import { useSetupState } from '../api/queries/deploy-setup.ts';
import { HelpHint } from './help/HelpHint.tsx';
import { Badge, Button, Select, TextArea } from './ui.tsx';

type Spec = FollowupSpec;

/** A deploy follow-up names an environment ("Test site"); `targetId` stays set for an older server. */
type DeploySpec = Extract<Spec, { kind: 'deploy' }> & { environment?: string };

export interface EnvOption {
  name: string;
  label: string;
  targetId: string;
  /** The live site: its release waits for the Owner. */
  live: boolean;
}

/** The project's environments as choices for a follow-up (test sites first, the live site last). */
export function useEnvironmentOptions(projectId: string | undefined): EnvOption[] {
  const q = useSetupState(projectId);
  const s = q.data;
  if (!s) return [];
  return (s.current.setup?.environments ?? [])
    .map((e) => {
      const t = s.targets.find((x) => x.name.toLowerCase() === e.target.toLowerCase());
      return { name: e.name, label: e.label, targetId: t?.id ?? '', live: !!t?.production };
    })
    .sort((a, b) => Number(a.live) - Number(b.live));
}

const envOf = (f: Spec, envs: readonly EnvOption[]) => {
  const named = (f as DeploySpec).environment;
  return (
    envs.find((e) => e.name === named) ?? envs.find((e) => f.kind === 'deploy' && e.targetId === f.targetId)
  );
};

const envChoiceLabel = (e: EnvOption) => (e.live ? `${e.label} (waits for you)` : e.label);

/** What stops the list being saved: a deploy needs a target, a custom item needs its instruction. */
export function followupProblems(
  list: readonly Spec[],
  targets: readonly DeployTargetDto[],
  envs: readonly EnvOption[] = [],
): string[] {
  const out: string[] = [];
  list.forEach((f, i) => {
    const n = i + 1;
    if (f.kind === 'deploy' && envs.length > 0) {
      const e = envOf(f, envs);
      if (!e) out.push(`Follow-up ${n}: choose where to release`);
      else if (!e.targetId) out.push(`Follow-up ${n}: ${e.label} has no place yet`);
    } else if (f.kind === 'deploy') {
      if (!f.targetId) out.push(`Follow-up ${n}: choose a deploy target`);
      else if (!targets.some((t) => t.id === f.targetId))
        out.push(`Follow-up ${n}: the deploy target no longer exists`);
    }
    if (f.kind === 'regression' && f.targetId && !targets.some((t) => t.id === f.targetId))
      out.push(`Follow-up ${n}: the target no longer exists`);
    if (f.kind === 'custom' && !f.instruction.trim()) out.push(`Follow-up ${n}: write the instruction`);
  });
  if (list.length > 10) out.push('At most 10 follow-ups');
  return out;
}

const KIND_LABEL = { deploy: 'Release', regression: 'Regression run', custom: 'Custom' } as const;
const STATUS_TONE = {
  pending: 'neutral',
  queued: 'neutral',
  briefed: 'blue',
  running: 'blue',
  succeeded: 'green',
  failed: 'red',
  skipped: 'amber',
  cancelled: 'neutral',
} as const;

const targetLabel = (t: DeployTargetDto) =>
  `${t.name} (${t.kind === 'local_docker' ? 'local Docker, every member workstation' : (t.host ?? 'remote host')})`;

/**
 * The ordered follow-up list of a phase (or a project's defaults). They run one after the other once approved; a
 * failure stops the ones after it. `readOnly` shows the frozen list with the live status and evidence of each one.
 */
export function FollowupEditor({
  value,
  onChange,
  targets,
  readOnly = false,
  details,
  unavailable = {},
  projectId,
}: {
  /** The project whose environments a release follow-up can target. */
  projectId?: string;
  /** Kinds the project cannot run (no repository, no test stage), with the reason: greyed out (`useFollowupAvailability`). */
  unavailable?: { deploy?: string | undefined; regression?: string | undefined };
  value: Spec[];
  onChange?: (next: Spec[]) => void;
  targets: DeployTargetDto[];
  readOnly?: boolean;
  details?: PhaseFollowupDto[];
}) {
  const envs = useEnvironmentOptions(projectId);
  const set = (i: number, patch: Partial<Spec> | Partial<DeploySpec>) =>
    onChange?.(value.map((f, j) => (j === i ? ({ ...f, ...patch } as Spec) : f)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    const a = next[i] as Spec;
    next[i] = next[j] as Spec;
    next[j] = a;
    onChange?.(next);
  };
  const add = (kind: Spec['kind']) => {
    const first = targets[0]?.id;
    const firstEnv = envs[0];
    const item: Spec =
      kind === 'deploy'
        ? firstEnv
          ? ({ kind, targetId: firstEnv.targetId, environment: firstEnv.name, note: '' } as Spec)
          : { kind, targetId: first ?? '', note: '' }
        : kind === 'regression'
          ? { kind, platform: 'web', note: '' }
          : { kind, instruction: '', note: '' };
    onChange?.([...value, item]);
  };
  const problems = readOnly ? [] : followupProblems(value, targets, envs);

  return (
    <div className="flex flex-col gap-2" data-testid="followup-editor">
      <div className="flex items-center gap-1 text-sm font-medium text-fg">
        Follow-ups
        <HelpHint article="phases#followups" label="About follow-ups">
          Follow-ups are steps that run by themselves, in order, after you approve a finished phase: for
          example a deploy, a regression run or a custom instruction.
        </HelpHint>
      </div>
      {value.length === 0 && (
        <p className="text-sm text-subtle" data-testid="followups-empty">
          No follow-ups: nothing runs after this phase.
        </p>
      )}
      <ol className="flex flex-col gap-2">
        {value.map((f, i) => {
          const d = details?.[i];
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: the list is positional
              key={i}
              data-testid={`followup-${i + 1}`}
              className="rounded-control border border-line p-2"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-xs text-subtle">{i + 1}.</span>
                <span className="font-medium">{KIND_LABEL[f.kind]}</span>
                {d && (
                  <span data-testid={`followup-status-${i + 1}`}>
                    <Badge tone={STATUS_TONE[d.status]}>{d.status}</Badge>
                  </span>
                )}
                {d?.delegate && <Badge>{`to ${d.delegate}`}</Badge>}
                {!readOnly && (
                  <span className="ml-auto flex gap-1">
                    <Button
                      variant="ghost"
                      aria-label={`Move follow-up ${i + 1} up`}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      Up
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`Move follow-up ${i + 1} down`}
                      disabled={i === value.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      Down
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`Remove follow-up ${i + 1}`}
                      onClick={() => onChange?.(value.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  </span>
                )}
              </div>
              {readOnly ? (
                <div className="mt-1 text-sm">
                  {f.kind === 'deploy' && (
                    <p>
                      Release to{' '}
                      {envOf(f, envs)?.label ??
                        d?.targetName ??
                        targets.find((t) => t.id === f.targetId)?.name ??
                        'a removed place'}
                    </p>
                  )}
                  {f.kind === 'regression' && (
                    <p>
                      Full {f.platform} regression run
                      {f.targetId
                        ? ` against ${d?.targetName ?? targets.find((t) => t.id === f.targetId)?.name ?? 'a removed target'}`
                        : ''}
                    </p>
                  )}
                  {f.kind === 'custom' && <p className="whitespace-pre-wrap">{f.instruction}</p>}
                  {f.note && <p className="text-xs text-subtle">Note: {f.note}</p>}
                  {d && <FollowupResult d={d} />}
                </div>
              ) : (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {f.kind === 'deploy' && envs.length > 0 && (
                    <Select
                      label="Release to"
                      value={envOf(f, envs)?.name ?? ''}
                      onChange={(e) => {
                        const env = envs.find((x) => x.name === e.target.value);
                        set(i, { targetId: env?.targetId ?? '', environment: env?.name ?? '' });
                      }}
                    >
                      <option value="">Choose a site</option>
                      {envs.map((e) => (
                        <option key={e.name} value={e.name}>
                          {envChoiceLabel(e)}
                        </option>
                      ))}
                    </Select>
                  )}
                  {f.kind === 'deploy' && envs.length === 0 && (
                    <Select
                      label="Deploy target"
                      value={f.targetId}
                      onChange={(e) => set(i, { targetId: e.target.value })}
                    >
                      <option value="">Choose a target</option>
                      {targets.map((t) => (
                        <option key={t.id} value={t.id}>
                          {targetLabel(t)}
                        </option>
                      ))}
                    </Select>
                  )}
                  {f.kind === 'regression' && (
                    <>
                      <Select
                        label="Platform"
                        value={f.platform}
                        onChange={(e) => set(i, { platform: e.target.value as 'web' | 'mobile' | 'both' })}
                      >
                        <option value="web">Web</option>
                        <option value="mobile">Mobile</option>
                        <option value="both">Both</option>
                      </Select>
                      <Select
                        label="Run against (optional)"
                        value={f.targetId ?? ''}
                        onChange={(e) => {
                          const { targetId: _drop, ...rest } = f;
                          onChange?.(
                            value.map((x, j) =>
                              j === i
                                ? ((e.target.value ? { ...rest, targetId: e.target.value } : rest) as Spec)
                                : x,
                            ),
                          );
                        }}
                      >
                        <option value="">The default environment</option>
                        {targets.map((t) => (
                          <option key={t.id} value={t.id}>
                            {targetLabel(t)}
                          </option>
                        ))}
                      </Select>
                    </>
                  )}
                  {f.kind === 'custom' && (
                    <div className="sm:col-span-2">
                      <TextArea
                        label="Instruction"
                        value={f.instruction}
                        onChange={(e) => set(i, { instruction: e.target.value })}
                      />
                    </div>
                  )}
                  <div className="sm:col-span-2">
                    <TextArea
                      label="Note for whoever does it (optional)"
                      rows={2}
                      value={f.note}
                      onChange={(e) => set(i, { note: e.target.value })}
                    />
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {!readOnly && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="add-deploy"
              disabled={value.length >= 10 || !!unavailable.deploy}
              title={unavailable.deploy}
              onClick={() => add('deploy')}
            >
              Add deploy
            </Button>
            <Button
              data-testid="add-regression"
              disabled={value.length >= 10 || !!unavailable.regression}
              title={unavailable.regression}
              onClick={() => add('regression')}
            >
              Add regression run
            </Button>
            <Button data-testid="add-custom" disabled={value.length >= 10} onClick={() => add('custom')}>
              Add custom
            </Button>
          </div>
          {(unavailable.deploy || unavailable.regression) && (
            <p className="text-xs text-subtle" data-testid="followup-unavailable">
              {unavailable.deploy ?? unavailable.regression}
            </p>
          )}
          {problems.length > 0 && (
            <ul
              role="alert"
              className="list-disc pl-5 text-xs font-medium text-danger"
              data-testid="followup-problems"
            >
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {envs.length > 0 && value.some((f) => f.kind === 'deploy') && (
            <p className="text-xs text-muted" data-testid="followup-sentence">
              When this phase is done:{' '}
              {value
                .filter((f) => f.kind === 'deploy')
                .map((f) => envOf(f, envs))
                .map((e, n) => `${n === 0 ? 'release to' : 'then'} ${e ? envChoiceLabel(e) : 'a site'}`)
                .join(', ')}
              .
            </p>
          )}
          <p className="text-xs text-subtle">
            They run in this order, one at a time, after you approve them. A failed one stops the ones after
            it.
          </p>
        </>
      )}
    </div>
  );
}

/** The result of one follow-up: summary, the DevOps requests, regression cards and bugs it produced. */
function FollowupResult({ d }: { d: PhaseFollowupDto }) {
  const bugRefs = (d.evidence.bugRefs as string[] | undefined) ?? [];
  const links = (d.evidence.links as string[] | undefined) ?? [];
  return (
    <div className="mt-1 text-xs" data-testid={`followup-result-${d.position}`}>
      {d.resultSummary && <p className="whitespace-pre-wrap">{d.resultSummary}</p>}
      {d.devopsRequests.length > 0 && (
        <ul className="mt-1 list-disc pl-4">
          {d.devopsRequests.map((r) => (
            <li key={r.id}>
              DevOps on {r.workstationName}: {r.status}
            </li>
          ))}
        </ul>
      )}
      {(d.regressionCards.length > 0 || bugRefs.length > 0) && (
        <p className="mt-1">
          {d.regressionCards.map((c) => (
            <Link key={c.id} to={`/cards/${c.id}`} className="mr-2 underline">
              {c.ref}
            </Link>
          ))}
          {bugRefs.map((ref) => (
            <Link key={ref} to={`/cards/${ref}`} className="mr-2 underline">
              bug {ref}
            </Link>
          ))}
        </p>
      )}
      {links.map((l) => (
        <a key={l} href={l} className="mr-2 underline" target="_blank" rel="noreferrer noopener">
          {l}
        </a>
      ))}
    </div>
  );
}
