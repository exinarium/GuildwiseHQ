import {
  type LocalTestService,
  LocalTestServicesSchema,
  MAX_TEST_SERVICES,
  type ProjectDetailResponse,
  TEST_SERVICE_HOSTS,
} from '@aom/shared';
import { useId, useState } from 'react';
import { useSetTestServices } from '../api/queries/projects.ts';
import { Button, ErrorBox, inputCls, Panel } from './ui.tsx';

/** One row as typed: the port stays text so "abc" or "0" can be typed and refused with a message. */
type Row = { name: string; host: string; port: string };
type RowErrors = { name?: string; host?: string; port?: string };

const toRows = (project: ProjectDetailResponse['project']): Row[] =>
  (project.testServices ?? []).map((s) => ({ name: s.name, host: s.host, port: String(s.port) }));

/** The shared schema's verdict per row and field, plus list-level messages (too many entries). */
export function validateRows(rows: Row[]): { errors: RowErrors[]; list: string | null; valid: boolean } {
  const errors: RowErrors[] = rows.map(() => ({}));
  const typed = rows.map((r) => ({
    name: r.name,
    host: r.host,
    port: r.port.trim() === '' ? Number.NaN : Number(r.port),
  }));
  const res = LocalTestServicesSchema.safeParse(typed);
  let list: string | null = null;
  if (!res.success) {
    for (const issue of res.error.issues) {
      const [i, field] = issue.path;
      if (typeof i === 'number' && (field === 'name' || field === 'host' || field === 'port')) {
        const row = errors[i];
        if (row && !row[field]) row[field] = issue.message;
      } else list = issue.message;
    }
  }
  return { errors, list, valid: res.success };
}

/** Keep the field being edited in view when the soft keyboard opens. */
const keepInView = (e: React.FocusEvent<HTMLInputElement>) => {
  const el = e.currentTarget;
  setTimeout(() => el.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 300);
};

/**
 * "Local test services": loopback host:port pairs on the workstation that this project's build, review and test shifts
 * may connect to from their sandbox (for example a test database). Edited as one list; the next shift uses the change.
 */
export function TestServicesPanel({
  projectId,
  project,
  canChange,
}: {
  projectId: string;
  project: ProjectDetailResponse['project'];
  canChange: boolean;
}) {
  const set = useSetTestServices(projectId);
  const hostsId = useId();
  const saved = toRows(project);
  const [rows, setRows] = useState<Row[] | null>(null);
  const shown = rows ?? saved;
  const dirty = rows !== null && JSON.stringify(rows) !== JSON.stringify(saved);
  const [tried, setTried] = useState(false);
  const check = validateRows(shown);

  const edit = (i: number, patch: Partial<Row>) => {
    setRows(shown.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    set.reset();
  };
  const save = () => {
    setTried(true);
    if (!check.valid) return;
    set.mutate(
      // every row passed the schema above, so the host is one of the loopback names
      shown.map((r) => ({
        name: r.name.trim(),
        host: r.host.trim(),
        port: Number(r.port),
      })) as LocalTestService[],
      {
        onSuccess: () => {
          setRows(null);
          setTried(false);
        },
      },
    );
  };

  return (
    <Panel data-testid="test-services-panel">
      <h2 className="mb-1 text-lg font-semibold text-fg">Local test services</h2>
      <p className="mb-3 text-sm text-muted">
        Build, review and test shifts of this project may connect to exactly these ports on the workstation
        (for example a test database), and to no other local port. Only 127.0.0.1, ::1 and localhost are
        accepted. Credentials stay in the test configuration, not here. Declare throwaway test services only.
        A change applies from the next shift that starts.
      </p>
      <datalist id={hostsId}>
        {TEST_SERVICE_HOSTS.map((h) => (
          <option key={h} value={h} />
        ))}
      </datalist>
      {shown.length === 0 && (
        <p className="mb-3 text-sm text-subtle" data-testid="test-services-empty">
          No local test services. Shifts of this project get no local port.
        </p>
      )}
      <ul className="space-y-3">
        {shown.map((r, i) => {
          const e = tried || dirty ? check.errors[i] : undefined;
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved
              key={i}
              className="flex flex-col gap-2 sm:flex-row sm:items-start"
              data-testid="test-service-row"
            >
              <div className="min-w-0 flex-1">
                <input
                  className={inputCls}
                  aria-label={`Name of service ${i + 1}`}
                  placeholder="Name, e.g. postgres-test"
                  value={r.name}
                  disabled={!canChange}
                  aria-invalid={!!e?.name}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onFocus={keepInView}
                  onChange={(ev) => edit(i, { name: ev.target.value })}
                />
                {e?.name && (
                  <p className="mt-1 text-sm text-danger" data-testid="test-service-error">
                    {e.name}
                  </p>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <input
                  className={inputCls}
                  aria-label={`Host of service ${i + 1}`}
                  placeholder="127.0.0.1"
                  list={hostsId}
                  value={r.host}
                  disabled={!canChange}
                  aria-invalid={!!e?.host}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onFocus={keepInView}
                  onChange={(ev) => edit(i, { host: ev.target.value })}
                />
                {e?.host && (
                  <p className="mt-1 text-sm text-danger" data-testid="test-service-error">
                    {e.host}
                  </p>
                )}
              </div>
              <div className="min-w-0 sm:w-32">
                <input
                  className={inputCls}
                  aria-label={`Port of service ${i + 1}`}
                  placeholder="Port"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={r.port}
                  disabled={!canChange}
                  aria-invalid={!!e?.port}
                  onFocus={keepInView}
                  onChange={(ev) => edit(i, { port: ev.target.value })}
                />
                {e?.port && (
                  <p className="mt-1 text-sm text-danger" data-testid="test-service-error">
                    {e.port}
                  </p>
                )}
              </div>
              {canChange && (
                <Button
                  variant="danger-ghost"
                  aria-label={`Remove service ${i + 1}`}
                  onClick={() => {
                    setRows(shown.filter((_, j) => j !== i));
                    set.reset();
                  }}
                >
                  Remove
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {check.list && (tried || dirty) && (
        <p className="mt-2 text-sm text-danger" data-testid="test-service-error">
          {check.list}
        </p>
      )}
      {canChange ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={shown.length >= MAX_TEST_SERVICES}
            onClick={() => {
              setRows([...shown, { name: '', host: '127.0.0.1', port: '' }]);
              set.reset();
            }}
          >
            Add service
          </Button>
          <Button variant="primary" disabled={!dirty || set.isPending} loading={set.isPending} onClick={save}>
            Save
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-sm text-subtle" data-testid="test-services-readonly">
          Only the project Owner and the organization's Owners and Admins can change this setting.
        </p>
      )}
      <ErrorBox error={set.error} />
    </Panel>
  );
}
