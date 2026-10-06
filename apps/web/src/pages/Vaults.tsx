import type { VaultDto } from '@aom/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { useProjects } from '../api/queries/projects.ts';
import {
  usePatchVault,
  useRegisterVault,
  useResolveVaultConflict,
  useVaults,
} from '../api/queries/vaults.ts';
import { Badge, Button, ErrorBox, PageHeader, Panel, Select, Spinner, TextInput } from '../components/ui.tsx';
import { formatDateTime } from '../lib/time.ts';

const KIND_LABEL = { work: 'Work vault', personal: 'Personal vault', project: 'Project vault' } as const;

/** Settings > Vaults: git URLs of the knowledge vaults. The site stores URLs and sync status, never vault content. */
export function Vaults() {
  const q = useVaults();
  const projects = useProjects();
  const owned = (projects.data ?? []).filter((p) => p.myRole === 'owner');
  const vaults = q.data ?? [];
  const has = (kind: 'work' | 'personal') => vaults.some((v) => v.kind === kind);
  const projectsWithoutVault = owned.filter((p) => !vaults.some((v) => v.projectId === p.id));

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-3">
      <PageHeader
        title="Vaults"
        sub="Git repositories of markdown that your agents read and your DevOps engineer keeps in sync on every workstation."
      />
      {q.isPending && <Spinner />}
      {q.isError && <ErrorBox error={q.error} />}
      <ul className="flex flex-col gap-3" data-testid="vaults">
        {vaults.map((v) => (
          <li key={v.id} data-testid={`vault-${v.projectId ? `project-${v.name}` : v.kind}`}>
            <VaultCard vault={v} projectKey={projects.data?.find((p) => p.id === v.projectId)?.key} />
          </li>
        ))}
      </ul>
      {vaults.length === 0 && q.data && (
        <Panel>
          <p className="text-sm text-subtle">
            No vault registered yet. Agents work without one, but decisions and standing orders are only
            written to a vault.
          </p>
        </Panel>
      )}
      <RegisterVault
        canWork={!has('work')}
        canPersonal={!has('personal')}
        projects={projectsWithoutVault.map((p) => ({ id: p.id, key: p.key, name: p.name }))}
      />
    </div>
  );
}

function VaultCard({ vault, projectKey }: { vault: VaultDto; projectKey?: string | undefined }) {
  const patch = usePatchVault();
  const resolve = useResolveVaultConflict();
  const [url, setUrl] = useState(vault.remoteUrl);
  const [interval, setIntervalSec] = useState(String(vault.syncIntervalSec));
  useEffect(() => {
    setUrl(vault.remoteUrl);
    setIntervalSec(String(vault.syncIntervalSec));
  }, [vault.remoteUrl, vault.syncIntervalSec]);
  const dirty = url.trim() !== vault.remoteUrl || Number(interval) !== vault.syncIntervalSec;
  const save = (e: FormEvent) => {
    e.preventDefault();
    patch.mutate({
      id: vault.id,
      body: {
        remoteUrl: url.trim(),
        syncIntervalSec: Math.max(1, Number(interval) || vault.syncIntervalSec),
      },
    });
  };
  return (
    <Panel>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">
          {vault.projectId ? vault.name : KIND_LABEL[vault.kind]}
          {projectKey && <span className="ml-1 font-normal text-subtle">({projectKey})</span>}
        </h2>
        <Badge>{vault.kind}</Badge>
        {!vault.canEdit && <Badge tone="blue">shared with you</Badge>}
      </div>
      <form
        onSubmit={save}
        className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-end"
        aria-label={`Edit ${vault.name}`}
      >
        <TextInput
          label="Git URL"
          value={url}
          disabled={!vault.canEdit}
          onChange={(e) => setUrl(e.target.value)}
        />
        <TextInput
          label="Sync interval (s)"
          inputMode="numeric"
          value={interval}
          disabled={!vault.canEdit}
          onChange={(e) => setIntervalSec(e.target.value)}
        />
        {vault.canEdit && (
          <Button type="submit" disabled={!dirty || patch.isPending}>
            Save
          </Button>
        )}
      </form>
      <ErrorBox error={patch.error ?? resolve.error} />
      <ul className="mt-3 flex flex-col gap-1.5 text-sm" data-testid="vault-workstations">
        {vault.workstations.length === 0 && (
          <li className="text-subtle">Pair a workstation to sync this vault.</li>
        )}
        {vault.workstations.map((w) => (
          <li
            key={w.workstationId}
            data-testid={`vault-ws-${w.workstationName}`}
            data-paused={w.paused ? 'true' : 'false'}
            className="flex flex-wrap items-center gap-x-3 gap-y-1"
          >
            <span className="font-medium">{w.workstationName}</span>
            {w.paused ? (
              <Badge tone="red">Sync paused: conflict</Badge>
            ) : w.lastError ? (
              <Badge tone="amber" title={w.lastError}>
                error
              </Badge>
            ) : w.localPath ? (
              <Badge tone="green">synced</Badge>
            ) : (
              <Badge>waiting for first sync</Badge>
            )}
            <span className="text-xs text-subtle">
              {w.lastPullAt ? `pulled ${formatDateTime(w.lastPullAt)}` : 'never pulled'}
              {w.lastPushAt ? ` · pushed ${formatDateTime(w.lastPushAt)}` : ''}
            </span>
            {w.lastError && !w.paused && <span className="text-xs text-warning">{w.lastError}</span>}
            {w.paused && (
              <>
                <span className="text-xs text-subtle">
                  Conflicting files: {w.conflictFiles.join(', ') || 'unknown'}. Resolve them in the clone
                  {w.localPath ? ` (${w.localPath})` : ''}, then resume.
                </span>
                <Button
                  disabled={resolve.isPending}
                  aria-label={`Resume sync on ${w.workstationName}`}
                  onClick={() => resolve.mutate({ id: vault.id, workstationId: w.workstationId })}
                >
                  I resolved it, resume
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function RegisterVault({
  canWork,
  canPersonal,
  projects,
}: {
  canWork: boolean;
  canPersonal: boolean;
  projects: Array<{ id: string; key: string; name: string }>;
}) {
  const register = useRegisterVault();
  const kinds = [
    ...(canWork ? [{ value: 'work', label: 'Work vault' }] : []),
    ...(canPersonal ? [{ value: 'personal', label: 'Personal vault' }] : []),
    ...(projects.length > 0 ? [{ value: 'project', label: 'Project vault (shared with members)' }] : []),
  ];
  const [kind, setKind] = useState('');
  const [projectId, setProjectId] = useState('');
  const [url, setUrl] = useState('');
  const [interval, setIntervalSec] = useState('300');
  const [err, setErr] = useState<Record<string, string>>({});
  const effKind = kinds.some((k) => k.value === kind) ? kind : (kinds[0]?.value ?? '');
  const effProject = projectId || projects[0]?.id || '';
  if (kinds.length === 0) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!url.trim()) errs.url = 'A git URL is required';
    const sec = Number(interval);
    if (!Number.isInteger(sec) || sec < 1) errs.interval = 'Whole seconds, at least 1';
    setErr(errs);
    if (Object.keys(errs).length) return;
    register.mutate(
      {
        kind: effKind as 'work',
        remoteUrl: url.trim(),
        syncIntervalSec: sec,
        ...(effKind === 'project' ? { projectId: effProject } : {}),
      },
      { onSuccess: () => setUrl('') },
    );
  };
  return (
    <Panel>
      <h2 className="mb-2 text-sm font-semibold">Register a vault</h2>
      <form onSubmit={submit} noValidate aria-label="Register vault" className="grid gap-3 sm:grid-cols-2">
        <Select label="Kind" value={effKind} onChange={(e) => setKind(e.target.value)}>
          {kinds.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
        {effKind === 'project' && (
          <Select label="Project" value={effProject} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} {p.name}
              </option>
            ))}
          </Select>
        )}
        <TextInput
          label="Git URL"
          placeholder="git@github.com:me/work-vault.git"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          error={err.url}
        />
        <TextInput
          label="Sync interval (seconds)"
          inputMode="numeric"
          value={interval}
          onChange={(e) => setIntervalSec(e.target.value)}
          error={err.interval}
        />
        <ErrorBox error={register.error} />
        <Button
          type="submit"
          variant="primary"
          className="self-start sm:col-span-2"
          disabled={register.isPending}
        >
          Register vault
        </Button>
      </form>
    </Panel>
  );
}
