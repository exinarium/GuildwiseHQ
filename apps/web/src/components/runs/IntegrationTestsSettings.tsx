import {
  DEFAULT_FLAKY_RETRY,
  DEFAULT_KEEP_ON_FAILURE_MIN,
  formatCommandLine,
  type IntegrationSuite,
  type IntegrationTests,
  parseCommandLine,
  validateIntegrationTests,
} from '@aom/shared';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useConfirmSuite, useIntegrationTests, useSaveIntegrationTests } from '../../api/queries/runs.ts';
import { Badge, Button, Callout, ErrorBox, Panel, Select, TextInput, useToast } from '../ui.tsx';

interface Row {
  key: number;
  name: string;
  repoId: string;
  cwd: string;
  cmd: string;
  kind: 'integration' | 'e2e';
  timeoutMin: number;
  destructive: boolean;
  junit: string;
  confirmed: boolean;
}

const toRow = (s: IntegrationSuite, key: number): Row => ({
  key,
  name: s.name,
  repoId: s.repoId,
  cwd: s.cwd,
  cmd: formatCommandLine(s.cmd),
  kind: s.kind,
  timeoutMin: s.timeoutMin,
  destructive: s.destructive,
  junit: s.junit ?? '',
  confirmed: s.confirmed,
});

function fromRow(r: Row): IntegrationSuite {
  const where = `Suite "${r.name || '(no name)'}"`;
  if (!r.name.trim()) throw new Error('Every suite needs a name');
  if (!r.cmd.trim()) throw new Error(`${where}: the command is empty`);
  try {
    return {
      name: r.name.trim(),
      repoId: r.repoId,
      cwd: r.cwd.trim() || '.',
      cmd: parseCommandLine(r.cmd),
      kind: r.kind,
      timeoutMin: r.timeoutMin,
      destructive: r.destructive,
      ...(r.junit.trim() ? { junit: r.junit.trim() } : {}),
      confirmed: r.confirmed,
    };
  } catch (err) {
    throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Project settings > Run and test > Integration tests (backlog #59): whether the tester runs integration and E2E tests
 * against a running copy of the branch, which suites it runs, and what happens after a failure. Every project starts
 * with this off; the owner switches it on.
 */
export function IntegrationTestsSettings({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const q = useIntegrationTests(projectId);
  const save = useSaveIntegrationTests(projectId);
  const confirm = useConfirmSuite(projectId);
  const toast = useToast();
  const [mode, setMode] = useState<IntegrationTests['mode']>('off');
  const [services, setServices] = useState('');
  const [keep, setKeep] = useState(DEFAULT_KEEP_ON_FAILURE_MIN);
  const [retry, setRetry] = useState(DEFAULT_FLAKY_RETRY);
  const [target, setTarget] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [problem, setProblem] = useState<string | undefined>();

  const data = q.data;
  useEffect(() => {
    if (!data) return;
    const s = data.settings;
    setMode(s.mode);
    setServices(s.services.join(' '));
    setKeep(s.keepOnFailureMin);
    setRetry(s.flakyRetry);
    setTarget(s.deployTargetId ?? '');
    setRows(s.suites.map((x, i) => toRow(x, i)));
  }, [data]);

  if (q.isPending) return <Panel title="Integration tests">Loading...</Panel>;
  if (q.isError)
    return (
      <Panel title="Integration tests">
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </Panel>
    );
  const { repos, targets, canProvision } = q.data;
  const patchRow = (key: number, over: Partial<Row>) =>
    setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...over } : r)));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(undefined);
    let suites: IntegrationSuite[];
    try {
      suites = rows.map(fromRow);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      return;
    }
    const settings: IntegrationTests = {
      mode,
      ...(mode === 'remote' && target ? { deployTargetId: target } : {}),
      services: services.split(/[\s,]+/).filter(Boolean),
      suites,
      keepOnFailureMin: keep,
      flakyRetry: retry,
    };
    const issues = validateIntegrationTests(
      settings,
      repos.map((r) => r.repoId),
    );
    if (issues.length) {
      setProblem(issues.join('; '));
      return;
    }
    save.mutate({ settings }, { onSuccess: () => toast.success('Integration test settings saved') });
  };

  return (
    <Panel title="Integration tests">
      <form
        onSubmit={submit}
        className="flex flex-col gap-4"
        aria-label="Integration test settings"
        data-testid="integration-settings"
      >
        <p className="text-sm text-muted">
          The tester can run integration and end-to-end tests against a running copy of each card's branch.
          When this is on, a card waits in Test while the runner starts its commit on the card's workstation
          (from the saved run plan above), the tester runs the suites against it, and the copy is stopped when
          the tester gives its verdict. It is off until you switch it on; with it off, cards skip the Test
          step. Builders and reviewers still run unit tests only.
        </p>
        <Select
          label="Run integration tests"
          value={mode}
          disabled={!canEdit}
          data-testid="integration-mode"
          onChange={(e) => setMode(e.target.value as IntegrationTests['mode'])}
        >
          <option value="off">Off</option>
          <option value="local">Yes, on the workstation that has the card</option>
          <option value="remote" disabled={targets.length === 0}>
            Yes, against a deployed target
          </option>
        </Select>
        {mode === 'local' && !canProvision && (
          <Callout tone="warning">
            None of the project's workstations runs a runner that can start test environments yet. Update the
            runner on the workstation that has a tester; until then the tester works as before.
          </Callout>
        )}
        {mode === 'remote' && (
          <Select
            label="Deploy target"
            value={target}
            disabled={!canEdit}
            data-testid="integration-target"
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Choose a target</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id} disabled={!t.testEnabled || t.production}>
                {t.name} ({t.url})
                {t.production ? ' - production, never tested' : t.testEnabled ? '' : ' - testing is off'}
              </option>
            ))}
          </Select>
        )}
        {mode !== 'off' && (
          <>
            {mode === 'local' && (
              <TextInput
                label="Services to start (optional)"
                value={services}
                disabled={!canEdit}
                placeholder="all of the plan"
                hint="Names from the run plan, separated by spaces. Their dependencies start with them."
                onChange={(e) => setServices(e.target.value)}
              />
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <TextInput
                label="Keep a failed card's copy for (minutes)"
                type="number"
                min={0}
                max={1440}
                value={keep}
                disabled={!canEdit}
                data-testid="integration-keep"
                hint="So you can open it and look. 0 stops it at once."
                onChange={(e) => setKeep(Math.max(0, Number(e.target.value) || 0))}
              />
              <TextInput
                label="Run a failing suite again (times)"
                type="number"
                min={0}
                max={3}
                value={retry}
                disabled={!canEdit}
                data-testid="integration-retry"
                hint="A pass on a retry counts as flaky and is shown on the card."
                onChange={(e) => setRetry(Math.min(3, Math.max(0, Number(e.target.value) || 0)))}
              />
            </div>

            <fieldset className="flex flex-col gap-3">
              <legend className="text-sm font-medium">Suites</legend>
              <p className="text-xs text-subtle">
                The tester runs every confirmed suite and needs a passing result for each before it can pass a
                card. With none listed, the tester reads TESTING.md, BUILD.md and the test config, runs what
                it finds and proposes it here for you to confirm.
              </p>
              {rows.map((r) => (
                <div
                  key={r.key}
                  className="flex flex-col gap-2 rounded-control border border-line p-3"
                  data-testid={`suite-row-${r.name || r.key}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {!r.confirmed && <Badge tone="warning">Proposed by a tester</Badge>}
                    {!r.confirmed && canEdit && (
                      <Button
                        size="sm"
                        data-testid={`confirm-suite-${r.name}`}
                        loading={confirm.isPending}
                        onClick={() => confirm.mutate({ name: r.name, confirmed: true })}
                      >
                        Confirm {r.name}
                      </Button>
                    )}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <TextInput
                      label="Name"
                      value={r.name}
                      disabled={!canEdit}
                      onChange={(e) => patchRow(r.key, { name: e.target.value })}
                    />
                    <Select
                      label="Kind"
                      value={r.kind}
                      disabled={!canEdit}
                      onChange={(e) => patchRow(r.key, { kind: e.target.value as Row['kind'] })}
                    >
                      <option value="integration">Integration</option>
                      <option value="e2e">End-to-end</option>
                    </Select>
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
                  </div>
                  <TextInput
                    label="Command"
                    value={r.cmd}
                    disabled={!canEdit}
                    placeholder="npx playwright test"
                    onChange={(e) => patchRow(r.key, { cmd: e.target.value })}
                  />
                  <div className="grid gap-2 sm:grid-cols-3">
                    <TextInput
                      label="Folder"
                      value={r.cwd}
                      disabled={!canEdit}
                      onChange={(e) => patchRow(r.key, { cwd: e.target.value })}
                    />
                    <TextInput
                      label="JUnit report (optional)"
                      value={r.junit}
                      disabled={!canEdit}
                      placeholder="results/*.xml"
                      onChange={(e) => patchRow(r.key, { junit: e.target.value })}
                    />
                    <TextInput
                      label="Longest run (minutes)"
                      type="number"
                      min={1}
                      max={120}
                      value={r.timeoutMin}
                      disabled={!canEdit}
                      onChange={(e) =>
                        patchRow(r.key, { timeoutMin: Math.max(1, Number(e.target.value) || 1) })
                      }
                    />
                  </div>
                  <label className="flex min-h-9 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={r.destructive}
                      disabled={!canEdit}
                      onChange={(e) => patchRow(r.key, { destructive: e.target.checked })}
                    />
                    Writes or deletes data (only runs against a target that allows it)
                  </label>
                  {canEdit && (
                    <div>
                      <Button
                        size="sm"
                        variant="danger-ghost"
                        onClick={() => setRows((cur) => cur.filter((x) => x.key !== r.key))}
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                        Remove {r.name || 'suite'}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
              {canEdit && repos.length > 0 && (
                <div>
                  <Button
                    data-testid="add-suite"
                    onClick={() =>
                      setRows((cur) => [
                        ...cur,
                        {
                          key: Math.max(-1, ...cur.map((x) => x.key)) + 1,
                          name: '',
                          repoId: repos[0]?.repoId ?? '',
                          cwd: '.',
                          cmd: '',
                          kind: 'integration',
                          timeoutMin: 20,
                          destructive: false,
                          junit: '',
                          confirmed: true,
                        },
                      ])
                    }
                  >
                    <Plus aria-hidden="true" className="size-4" />
                    Add a suite
                  </Button>
                </div>
              )}
            </fieldset>
          </>
        )}

        {problem && (
          <p role="alert" className="text-sm font-medium text-danger" data-testid="integration-problem">
            {problem}
          </p>
        )}
        <ErrorBox error={save.error} />
        {canEdit ? (
          <div>
            <Button type="submit" variant="primary" loading={save.isPending} data-testid="integration-save">
              Save integration test settings
            </Button>
          </div>
        ) : (
          <p className="text-xs text-subtle">Only the project owner changes these.</p>
        )}
      </form>
    </Panel>
  );
}
