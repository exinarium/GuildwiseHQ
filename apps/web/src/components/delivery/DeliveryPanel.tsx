import type { DeliverySettingsResponse } from '@aom/shared';
import { useState } from 'react';
import {
  useApproveRecipe,
  useDelivery,
  useDeploy,
  useInspectRecipe,
  useRejectRecipe,
  useSetDeliveryMode,
  useSetDeploySecret,
} from '../../api/queries/delivery.ts';
import { useProjectWorkstations } from '../../api/queries/phases.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Button, Callout, ErrorBox, Panel, Select, TextInput, useToast } from '../ui.tsx';

const STATUS: Record<string, { label: string; tone: 'neutral' | 'green' | 'amber' | 'red' }> = {
  observed: { label: 'waiting for your approval', tone: 'amber' },
  approved: { label: 'approved', tone: 'green' },
  changed_unapproved: { label: 'changed: needs a new approval', tone: 'red' },
  rejected: { label: 'rejected', tone: 'neutral' },
  absent: { label: 'no recipe in the vault', tone: 'neutral' },
};
const RELEASER: Record<string, string> = {
  owner: 'the Owner or an Admin (release queue)',
  ceo: 'the CEO, once the gate holds',
  auto: 'automatically, once the gate holds',
};

/**
 * Delivery (docs/design/ceo-front-door.md section 9 and 14): how this project deploys. `Instructions` is the older way (a
 * DevOps request in words); `Recipe` runs the recipe kept in the project vault, which only the Owner approves, version by
 * version. The recipe is set up in conversation with the CEO; this section shows it, approves it and holds its secrets.
 */
export function DeliveryPanel({ projectId }: { projectId: string }) {
  const q = useDelivery(projectId);
  const setMode = useSetDeliveryMode(projectId);
  const inspect = useInspectRecipe(projectId);
  const approve = useApproveRecipe(projectId);
  const reject = useRejectRecipe(projectId);
  const toast = useToast();
  if (!q.data)
    return q.error ? (
      <Panel>
        <ErrorBox error={q.error} />
      </Panel>
    ) : null;
  const d = q.data;
  const r = d.recipe;
  const st = r ? (STATUS[r.status] ?? STATUS.observed) : undefined;
  const errors = (r?.lint ?? []).filter((l) => l.level === 'error');
  return (
    <Panel data-testid="delivery-panel">
      <h2 className="mb-1 text-lg font-semibold text-fg">Delivery</h2>
      <p className="mb-3 text-sm text-muted">
        How this project is deployed. With a <strong>recipe</strong>, deploys run a script you approved, on
        your workstation, outside any model; a model only asks Guildwise, which checks the approved version
        and the gate. To set one up, ask the CEO: "set up deploys for this project".
      </p>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Select
          label="Delivery mode"
          value={d.mode}
          disabled={!d.canChangeMode || setMode.isPending}
          onChange={(e) => setMode.mutate(e.target.value as 'instructions' | 'recipe')}
          data-testid="delivery-mode"
        >
          <option value="instructions">Instructions (a DevOps request in words)</option>
          <option value="recipe" disabled={!r?.approvedHash}>
            Recipe (approved script, gate, release queue)
          </option>
        </Select>
        {!r?.approvedHash && d.mode === 'instructions' && (
          <span className="text-xs text-subtle">
            A project switches to recipe once it has an approved recipe.
          </span>
        )}
      </div>
      <ErrorBox error={setMode.error} />
      <VaultLine vault={d.vault} />
      {!r?.present ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-subtle" data-testid="delivery-no-recipe">
            There is no recipe in the project vault yet.
          </p>
          <Button size="sm" variant="ghost" loading={inspect.isPending} onClick={() => inspect.mutate()}>
            Check for changes
          </Button>
          <ErrorBox error={inspect.error} />
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3" data-testid="delivery-recipe">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-fg">Recipe</span>
            {st && <Badge tone={st.tone}>{st.label}</Badge>}
            <span className="font-mono text-xs text-subtle" title="the content hash of delivery/ you approve">
              {r.observedHash?.slice(0, 12)}
            </span>
            {r.version > 0 && (
              <span className="text-xs text-subtle">
                version {r.version} approved {formatDateTime(r.approvedAt)}
              </span>
            )}
          </div>
          {r.changes.length > 0 && (
            <div data-testid="recipe-changes">
              <p className="text-xs font-medium text-muted">Changed since the approved version</p>
              <ul className="list-disc pl-5 text-sm text-muted">
                {r.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <Environments d={d} />
          {(r.lint ?? []).length > 0 && (
            <ul className="text-sm" data-testid="recipe-lint">
              {r.lint.map((l) => (
                <li
                  key={`${l.code}-${l.message}`}
                  className={l.level === 'error' ? 'text-danger' : 'text-warning'}
                >
                  {l.level === 'error' ? 'Must fix: ' : 'Note: '}
                  {l.message}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            {r.status !== 'approved' && r.observedHash && (
              <>
                <Button
                  variant="primary"
                  disabled={!d.canApprove || errors.length > 0}
                  loading={approve.isPending}
                  data-testid="approve-recipe"
                  onClick={() =>
                    approve.mutate(r.observedHash as string, {
                      onSuccess: () => toast.success('Recipe approved'),
                    })
                  }
                >
                  Approve this version
                </Button>
                {d.canApprove && (
                  <Button
                    loading={reject.isPending}
                    onClick={() => reject.mutate({ hash: r.observedHash as string })}
                  >
                    Reject
                  </Button>
                )}
                {!d.canApprove && (
                  <span className="self-center text-xs text-subtle">Only the Owner approves a recipe.</span>
                )}
              </>
            )}
            <Button size="sm" variant="ghost" loading={inspect.isPending} onClick={() => inspect.mutate()}>
              Check for changes
            </Button>
          </div>
          <ErrorBox error={approve.error ?? reject.error ?? inspect.error} />
        </div>
      )}
      {d.mode === 'recipe' && r?.status === 'approved' && <DeployButtons projectId={projectId} d={d} />}
      {r?.present && <Secrets projectId={projectId} d={d} />}
    </Panel>
  );
}

function VaultLine({ vault }: { vault: DeliverySettingsResponse['vault'] }) {
  if (!vault)
    return (
      <Callout tone="warning" className="mt-2">
        This project has no vault yet. Recipes are kept in the project vault (a git repository is recommended;
        without one it is a folder on the Owner's workstation).
      </Callout>
    );
  return (
    <p className="text-xs text-subtle" data-testid="delivery-vault">
      The recipe lives in <span className="font-mono">{vault.folder}/delivery/</span> of the project vault "
      {vault.name}".{' '}
      {vault.storage === 'git'
        ? 'The vault is a git repository: it is backed up with it.'
        : "This vault is a local folder on the Owner's workstation and is not backed up by Guildwise: keep it in a backed-up folder (OneDrive, iCloud, ...) or give the project a git repository."}
    </p>
  );
}

function Environments({ d }: { d: DeliverySettingsResponse }) {
  return (
    <table className="w-full text-left text-sm" data-testid="recipe-environments">
      <thead className="text-xs text-subtle">
        <tr>
          <th className="py-1 pr-2 font-medium">Environment</th>
          <th className="py-1 pr-2 font-medium">Where</th>
          <th className="py-1 pr-2 font-medium">Released by</th>
          <th className="py-1 font-medium">Gate</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {d.environments.map((e) => (
          <tr key={e.name} data-testid={`env-${e.name}`}>
            <td className="py-1.5 pr-2 font-medium">{e.name}</td>
            <td className="py-1.5 pr-2">
              {e.targets.map((t) => (
                <span key={t.name} className="mr-1 inline-flex items-center gap-1">
                  {t.name}
                  {t.production && <Badge tone="danger">production</Badge>}
                  {!t.exists && <Badge tone="amber">no such target</Badge>}
                </span>
              ))}
            </td>
            <td className="py-1.5 pr-2">{RELEASER[e.releasedBy]}</td>
            <td className="py-1.5 text-xs text-muted">
              {e.gate === 'none' ? 'none' : e.gate === 'inline' ? 'its own' : `preset ${e.gate}`}
              {e.triggers.length > 0 && e.triggers[0] !== 'on_request'
                ? `, on ${e.triggers.join(' and ').replace('_', ' ')}`
                : ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The Deploy button: the same server path as the CEO's call, from your session, no model involved. */
function DeployButtons({ projectId, d }: { projectId: string; d: DeliverySettingsResponse }) {
  const deploy = useDeploy(projectId);
  const [msg, setMsg] = useState('');
  if (!d.canChangeMode) return null;
  return (
    <div className="mt-4 border-t border-line pt-3" data-testid="deploy-buttons">
      <p className="mb-2 text-xs font-medium text-muted">Deploy now</p>
      <div className="flex flex-wrap gap-2">
        {d.environments.map((e) => (
          <Button
            key={e.name}
            size="sm"
            loading={deploy.isPending && deploy.variables?.env === e.name}
            data-testid={`deploy-${e.name}`}
            onClick={() => deploy.mutate({ env: e.name }, { onSuccess: (r) => setMsg(r.message) })}
          >
            Deploy {e.name}
          </Button>
        ))}
      </div>
      {msg && (
        <p className="mt-2 text-xs text-muted" role="status">
          {msg}
        </p>
      )}
      <ErrorBox error={deploy.error} />
    </div>
  );
}

/** Secrets the recipe names: set the value on one of your workstations. It is encrypted here for the runner and never reaches Guildwise. */
function Secrets({ projectId, d }: { projectId: string; d: DeliverySettingsResponse }) {
  const names = [...new Set(d.environments.flatMap((e) => e.secrets))];
  const ws = useProjectWorkstations(projectId);
  const mine = (ws.data ?? []).filter((w) => w.mine);
  const set = useSetDeploySecret(projectId);
  const toast = useToast();
  const [wsId, setWsId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  if (names.length === 0) return null;
  const target = wsId || mine[0]?.id || '';
  const held = (n: string) => d.secrets.find((s) => s.workstationId === target && s.name === n);
  return (
    <div className="mt-4 border-t border-line pt-3" data-testid="delivery-secrets">
      <p className="mb-1 text-xs font-medium text-muted">Secrets the recipe names</p>
      <Callout tone="info" className="mb-2">
        A value is encrypted in your browser for the runner of the workstation you choose and kept only there.
        Guildwise never sees it, and it is hidden from every log.
      </Callout>
      {mine.length > 1 && (
        <Select label="On workstation" value={target} onChange={(e) => setWsId(e.target.value)}>
          {mine.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      )}
      {names.map((n) => {
        const h = held(n);
        return (
          <div key={n} className="mt-2 flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1">
              <TextInput
                label={n}
                type="password"
                autoComplete="off"
                value={values[n] ?? ''}
                placeholder={h ? 'set: type to replace' : 'not set on this workstation'}
                hint={h ? `Set ${formatDateTime(h.setAt)}` : undefined}
                data-testid={`deploy-secret-${n}`}
                onChange={(e) => setValues((c) => ({ ...c, [n]: e.target.value }))}
              />
            </div>
            <Button
              disabled={!values[n] || !target}
              loading={set.isPending}
              data-testid={`deploy-secret-save-${n}`}
              onClick={() =>
                set.mutate(
                  { workstationId: target, name: n, value: values[n] ?? '' },
                  {
                    onSuccess: () => {
                      setValues((c) => ({ ...c, [n]: '' }));
                      toast.success(`${n} sent to the workstation`);
                    },
                  },
                )
              }
            >
              Set {n}
            </Button>
          </div>
        );
      })}
      <ErrorBox error={set.error} />
    </div>
  );
}
