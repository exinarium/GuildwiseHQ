import {
  formatCommandLine,
  formatRunHealth,
  formatRunPort,
  parseCommandLine,
  parseRunHealth,
  parseRunPort,
  type RunDeclaredService,
  type RunPlanDto,
  type SetRunSettingsRequest,
  validateRunSettings,
} from '@aom/shared';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useRunSettings, useSaveRunSettings } from '../../api/queries/runs.ts';
import { Badge, Button, Callout, ErrorBox, Panel, Select, TextArea, TextInput, useToast } from '../ui.tsx';

interface Row {
  key: number;
  name: string;
  repoId: string;
  cwd: string;
  cmd: string;
  envFile: string;
  ports: string;
  health: string;
  after: string;
}

const words = (s: string) => s.split(/[\s,]+/).filter(Boolean);

function toRow(s: RunDeclaredService, key: number): Row {
  return {
    key,
    name: s.name,
    repoId: s.repoId,
    cwd: s.cwd,
    cmd: s.cmd ? formatCommandLine(s.cmd) : '',
    envFile: s.envFile ?? '',
    ports: s.ports.map(formatRunPort).join(' '),
    health: s.health ? formatRunHealth(s.health) : '',
    after: s.after.join(' '),
  };
}

/** Throws with a message the form shows when a row cannot be turned into a service. */
function fromRow(r: Row): RunDeclaredService {
  const where = `Service "${r.name || '(no name)'}"`;
  try {
    return {
      name: r.name.trim(),
      repoId: r.repoId,
      cwd: r.cwd.trim() || '.',
      ...(r.cmd.trim() ? { cmd: parseCommandLine(r.cmd) } : {}),
      ...(r.envFile.trim() ? { envFile: r.envFile.trim() } : {}),
      ports: words(r.ports).map(parseRunPort),
      ...(r.health.trim() ? { health: parseRunHealth(r.health.trim()) } : {}),
      after: words(r.after),
    };
  } catch (err) {
    throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Project settings > Run and test (backlog #58): run instructions for the project and for each repository, the stop
 * time and Docker opt-in, the services the project declares (they pre-fill the plan, DevOps may not contradict them)
 * and, read-only, the plan the DevOps engineer saved for each workstation.
 */
export function RunSettings({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const q = useRunSettings(projectId);
  const save = useSaveRunSettings(projectId);
  const toast = useToast();
  const [instructions, setInstructions] = useState('');
  const [repoText, setRepoText] = useState<Record<string, string>>({});
  const [ttl, setTtl] = useState(8);
  const [docker, setDocker] = useState(false);
  const [guides, setGuides] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [problem, setProblem] = useState<string | undefined>();

  const data = q.data;
  useEffect(() => {
    if (!data) return;
    setInstructions(data.runInstructions);
    setRepoText(Object.fromEntries(data.repos.map((r) => [r.repoId, r.runInstructions])));
    setTtl(data.settings.ttlHours);
    setDocker(data.settings.allowDocker);
    setGuides((data.settings.buildGuides ?? []).join('\n'));
    setRows(data.settings.services.map((s, i) => toRow(s, i)));
  }, [data]);

  if (q.isPending) return <Panel title="Run and test">Loading...</Panel>;
  if (q.isError)
    return (
      <Panel title="Run and test">
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </Panel>
    );
  const repos = q.data.repos;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(undefined);
    let services: RunDeclaredService[];
    try {
      services = rows.map(fromRow);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      return;
    }
    const body: SetRunSettingsRequest = {
      runInstructions: instructions,
      repoInstructions: repos.map((r) => ({ repoId: r.repoId, runInstructions: repoText[r.repoId] ?? '' })),
      settings: {
        ttlHours: ttl,
        allowDocker: docker,
        services,
        buildGuides: guides
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      },
    };
    const issues = validateRunSettings(body.settings);
    if (issues.length) {
      setProblem(issues.join('; '));
      return;
    }
    save.mutate(body, { onSuccess: () => toast.success('Run settings saved') });
  };
  const patchRow = (key: number, over: Partial<Row>) =>
    setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...over } : r)));

  return (
    <Panel title="Run and test">
      <form
        onSubmit={submit}
        className="flex flex-col gap-4"
        aria-label="Run and test settings"
        data-testid="run-settings"
      >
        <p className="text-sm text-muted">
          Tell the DevOps engineer how to run this project. It reads this and the repository's BUILD.md the
          first time someone starts a branch, works out the steps and saves them as a plan for the
          workstation. Later starts replay that plan with no DevOps run; changing these settings or BUILD.md
          makes the plan stale and the DevOps engineer works it out again. Nothing is added to your
          repositories.
        </p>
        <TextArea
          label="Run instructions"
          rows={5}
          value={instructions}
          disabled={!canEdit}
          hint="Free text for the whole project. It wins over BUILD.md where they disagree."
          data-testid="run-instructions"
          onChange={(e) => setInstructions(e.target.value)}
        />
        <TextArea
          label="Build guide (optional)"
          rows={2}
          value={guides}
          disabled={!canEdit}
          hint="Absolute path(s) on the workstation, one per line, for example /home/you/src/sources/BUILD.md. When set, only these guides are given to the DevOps engineer; otherwise the runner finds BUILD.md in the repository and in the folders above the clones. The files are read when an environment starts and are not stored here."
          data-testid="run-build-guides"
          onChange={(e) => setGuides(e.target.value)}
        />
        {repos.map((r) => (
          <TextArea
            key={r.repoId}
            label={`Run instructions for ${r.name}`}
            rows={3}
            value={repoText[r.repoId] ?? ''}
            disabled={!canEdit}
            data-testid={`run-instructions-${r.name}`}
            onChange={(e) => setRepoText((cur) => ({ ...cur, [r.repoId]: e.target.value }))}
          />
        ))}
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-40">
            <TextInput
              label="Stops after (hours)"
              type="number"
              min={1}
              max={72}
              value={ttl}
              disabled={!canEdit}
              data-testid="run-ttl"
              onChange={(e) => setTtl(Number(e.target.value) || 1)}
            />
          </div>
          <label className="flex min-h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={docker}
              disabled={!canEdit}
              data-testid="run-docker"
              onChange={(e) => setDocker(e.target.checked)}
            />
            Branch code may use Docker
          </label>
        </div>
        {docker && (
          <Callout tone="warning">
            Docker (compose, docker run) gives the code root-equivalent access to this machine. With this on,
            such steps run outside any sandbox.
          </Callout>
        )}

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">Services (optional)</legend>
          <p className="text-xs text-subtle">
            Declare what you already know. The DevOps engineer uses these names, commands, ports and health
            checks as they are. Ports are <code>name:default[:ENV_VAR]</code> (the variable the app reads its
            port from), a health check is a URL, <code>tcp:port</code>, <code>log:regex</code> or{' '}
            <code>none:seconds</code>. <code>{'${port}'}</code> stands for the service's port.
          </p>
          {rows.map((r) => (
            <div
              key={r.key}
              className="flex flex-col gap-2 rounded-control border border-line p-3"
              data-testid={`run-service-row-${r.name || r.key}`}
            >
              <div className="grid gap-2 sm:grid-cols-3">
                <TextInput
                  label="Name"
                  value={r.name}
                  disabled={!canEdit}
                  onChange={(e) => patchRow(r.key, { name: e.target.value })}
                />
                <Select
                  label="Repository"
                  value={r.repoId}
                  disabled={!canEdit}
                  onChange={(e) => patchRow(r.key, { repoId: e.target.value })}
                >
                  {repos.map((x) => (
                    <option key={x.repoId} value={x.repoId}>
                      {x.name}
                    </option>
                  ))}
                </Select>
                <TextInput
                  label="Folder"
                  value={r.cwd}
                  disabled={!canEdit}
                  onChange={(e) => patchRow(r.key, { cwd: e.target.value })}
                />
              </div>
              <TextInput
                label="Command"
                value={r.cmd}
                disabled={!canEdit}
                placeholder="npm run dev"
                onChange={(e) => patchRow(r.key, { cmd: e.target.value })}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <TextInput
                  label="Ports"
                  value={r.ports}
                  disabled={!canEdit}
                  placeholder="http:5173:PORT"
                  onChange={(e) => patchRow(r.key, { ports: e.target.value })}
                />
                <TextInput
                  label="Health check"
                  value={r.health}
                  disabled={!canEdit}
                  placeholder="http://localhost:${port}/health"
                  onChange={(e) => patchRow(r.key, { health: e.target.value })}
                />
                <TextInput
                  label="Starts after"
                  value={r.after}
                  disabled={!canEdit}
                  placeholder="db api"
                  onChange={(e) => patchRow(r.key, { after: e.target.value })}
                />
                <TextInput
                  label="Env file (absolute path on the workstation)"
                  value={r.envFile}
                  disabled={!canEdit}
                  placeholder="/home/you/.config/app/api.env"
                  onChange={(e) => patchRow(r.key, { envFile: e.target.value })}
                />
              </div>
              {canEdit && (
                <div>
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    onClick={() => setRows((cur) => cur.filter((x) => x.key !== r.key))}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                    Remove {r.name || 'service'}
                  </Button>
                </div>
              )}
            </div>
          ))}
          {canEdit && repos.length > 0 && (
            <div>
              <Button
                data-testid="run-add-service"
                onClick={() =>
                  setRows((cur) => [
                    ...cur,
                    {
                      key: Math.max(-1, ...cur.map((x) => x.key)) + 1,
                      name: '',
                      repoId: repos[0]?.repoId ?? '',
                      cwd: '.',
                      cmd: '',
                      envFile: '',
                      ports: '',
                      health: '',
                      after: '',
                    },
                  ])
                }
              >
                <Plus aria-hidden="true" className="size-4" />
                Add a service
              </Button>
            </div>
          )}
        </fieldset>

        {problem && (
          <p role="alert" className="text-sm font-medium text-danger" data-testid="run-settings-problem">
            {problem}
          </p>
        )}
        <ErrorBox error={save.error} />
        {canEdit ? (
          <div>
            <Button type="submit" variant="primary" loading={save.isPending} data-testid="run-settings-save">
              Save run settings
            </Button>
          </div>
        ) : (
          <p className="text-xs text-subtle">Only the project owner changes these.</p>
        )}
      </form>
      <PlanView plans={q.data.plans} />
    </Panel>
  );
}

function PlanView({ plans }: { plans: RunPlanDto[] }) {
  return (
    <div className="mt-6 flex flex-col gap-3" data-testid="run-plans">
      <h3 className="text-sm font-medium">Saved plans</h3>
      {plans.length === 0 && (
        <p className="text-sm text-muted">
          No plan yet. The first time someone starts a branch, the DevOps engineer saves one here.
        </p>
      )}
      {plans.map((p) => (
        <div
          key={p.id}
          className="rounded-control border border-line p-3 text-sm"
          data-testid={`run-plan-${p.workstationName}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{p.workstationName}</span>
            <Badge tone={p.status === 'active' ? 'success' : 'warning'}>
              version {p.version}, {p.status}
            </Badge>
            <span className="text-xs text-muted">saved {new Date(p.savedAt).toLocaleString()}</span>
          </div>
          {p.status === 'stale' && (
            <p className="mt-1 text-xs text-muted" data-testid="run-plan-stale">
              These settings or BUILD.md changed after the plan was saved. The next start goes through the
              DevOps engineer, who saves a new version.
            </p>
          )}
          {p.plan.setup.length > 0 && (
            <>
              <p className="mt-2 text-xs font-medium text-muted">Setup steps</p>
              <ol className="list-decimal pl-5">
                {p.plan.setup.map((s) => (
                  <li key={s.name}>
                    {s.name}: <code className="font-mono text-xs">{formatCommandLine(s.cmd)}</code>
                  </li>
                ))}
              </ol>
            </>
          )}
          <p className="mt-2 text-xs font-medium text-muted">Services</p>
          <ul className="list-disc pl-5">
            {p.plan.services.map((s) => (
              <li key={s.name}>
                {s.name}: <code className="font-mono text-xs">{formatCommandLine(s.cmd)}</code>
                {s.ports.length > 0 && (
                  <span className="text-muted"> · ports {s.ports.map(formatRunPort).join(' ')}</span>
                )}
                <span className="text-muted"> · health {formatRunHealth(s.health)}</span>
                {s.after.length > 0 && <span className="text-muted"> · after {s.after.join(', ')}</span>}
                {s.envFile && <span className="text-muted"> · env file {s.envFile}</span>}
              </li>
            ))}
          </ul>
          {p.plan.notes && <p className="mt-2 whitespace-pre-wrap text-muted">{p.plan.notes}</p>}
        </div>
      ))}
    </div>
  );
}
