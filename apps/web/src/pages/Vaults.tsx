import type { VaultDto } from '@aom/shared';
import { Vault as VaultIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useProjects } from '../api/queries/projects.ts';
import {
  usePatchVault,
  useRegisterVault,
  useResolveVaultConflict,
  useVaults,
} from '../api/queries/vaults.ts';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Panel,
  Select,
  TextInput,
  useToast,
} from '../components/ui.tsx';
import { formatDateTime } from '../lib/time.ts';

const KIND_LABEL = { work: 'Work vault', personal: 'Personal vault', project: 'Project vault' } as const;

/** Settings > Vaults: git URLs of the knowledge vaults. The site stores URLs and sync status, never vault content. */
export function Vaults() {
  const q = useVaults();
  const projects = useProjects();
  const [registering, setRegistering] = useState(false);
  const owned = (projects.data ?? []).filter((p) => p.myRole === 'owner');
  const vaults = q.data ?? [];
  const has = (kind: 'work' | 'personal') => vaults.some((v) => v.kind === kind);
  const projectsWithoutVault = owned.filter((p) => !vaults.some((v) => v.projectId === p.id));
  const canRegister = !has('work') || !has('personal') || projectsWithoutVault.length > 0;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <PageHeader
        title="Vaults"
        sub="Git repositories of markdown that your agents read and your DevOps engineer keeps in sync on every workstation."
        actions={
          canRegister && (
            <Button variant="primary" onClick={() => setRegistering(true)}>
              Register a vault
            </Button>
          )
        }
      />
      {q.isPending && <ListSkeleton label="Loading vaults" rows={2} />}
      {q.isError && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      <ul className="flex flex-col gap-4" data-testid="vaults">
        {vaults.map((v) => (
          <li key={v.id} data-testid={`vault-${v.projectId ? `project-${v.name}` : v.kind}`}>
            <VaultCard vault={v} projectKey={projects.data?.find((p) => p.id === v.projectId)?.key} />
          </li>
        ))}
      </ul>
      {vaults.length === 0 && q.data && (
        <EmptyState
          icon={VaultIcon}
          title="No vault yet"
          description="A vault is a git repository of markdown notes your agents read. Decisions and standing orders are written to it."
          action={
            <Button variant="primary" onClick={() => setRegistering(true)}>
              Register a vault
            </Button>
          }
        />
      )}
      <Dialog
        open={registering}
        onOpenChange={setRegistering}
        title="Register a vault"
        description="Give the git URL of an existing repository. Agents never see credentials: the workstation uses its own git access."
      >
        <RegisterVault
          canWork={!has('work')}
          canPersonal={!has('personal')}
          projects={projectsWithoutVault.map((p) => ({ id: p.id, key: p.key, name: p.name }))}
          onDone={() => setRegistering(false)}
        />
      </Dialog>
    </div>
  );
}

function VaultCard({ vault, projectKey }: { vault: VaultDto; projectKey?: string | undefined }) {
  const patch = usePatchVault();
  const resolve = useResolveVaultConflict();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(vault.remoteUrl);
  const [interval, setIntervalSec] = useState(String(vault.syncIntervalSec));
  useEffect(() => {
    setUrl(vault.remoteUrl);
    setIntervalSec(String(vault.syncIntervalSec));
  }, [vault.remoteUrl, vault.syncIntervalSec]);
  const dirty = url.trim() !== vault.remoteUrl || Number(interval) !== vault.syncIntervalSec;
  const save = (e: FormEvent) => {
    e.preventDefault();
    patch.mutate(
      {
        id: vault.id,
        body: {
          remoteUrl: url.trim(),
          syncIntervalSec: Math.max(1, Number(interval) || vault.syncIntervalSec),
        },
      },
      {
        onSuccess: () => {
          toast.success('Vault saved');
          setEditing(false);
        },
      },
    );
  };
  const synced = vault.workstations.filter((w) => !w.paused && !w.lastError && w.localPath).length;
  return (
    <Panel>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-fg">
          {vault.projectId ? vault.name : KIND_LABEL[vault.kind]}
          {projectKey && <span className="ml-1 font-normal text-subtle">({projectKey})</span>}
        </h2>
        <Badge>{vault.kind}</Badge>
        {!vault.canEdit && <Badge tone="blue">shared with you</Badge>}
        {vault.workstations.length > 0 && (
          <span className="text-sm text-muted">
            Synced on {synced} of {vault.workstations.length}
          </span>
        )}
        {vault.canEdit && (
          <Button
            className="ml-auto"
            size="sm"
            aria-label={`Edit ${vault.name}`}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        )}
      </div>
      <p className="font-mono text-xs break-all text-subtle">
        {vault.remoteUrl} · every {vault.syncIntervalSec}s
      </p>
      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title={`Edit ${vault.name}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={`vault-form-${vault.id}`}
              variant="primary"
              disabled={!dirty}
              loading={patch.isPending}
            >
              Save
            </Button>
          </>
        }
      >
        <form
          id={`vault-form-${vault.id}`}
          onSubmit={save}
          className="flex flex-col gap-4"
          aria-label={`Edit ${vault.name} form`}
        >
          <TextInput label="Git URL" value={url} onChange={(e) => setUrl(e.target.value)} />
          <TextInput
            label="Sync interval (s)"
            inputMode="numeric"
            value={interval}
            onChange={(e) => setIntervalSec(e.target.value)}
          />
          <ErrorBox error={patch.error} />
        </form>
      </Dialog>
      <ErrorBox error={resolve.error} />
      <ul
        className="mt-4 flex flex-col divide-y divide-line border-t border-line text-sm"
        data-testid="vault-workstations"
      >
        {vault.workstations.length === 0 && (
          <li className="pt-3 text-subtle">Pair a workstation to sync this vault.</li>
        )}
        {vault.workstations.map((w) => (
          <li
            key={w.workstationId}
            data-testid={`vault-ws-${w.workstationName}`}
            data-paused={w.paused ? 'true' : 'false'}
            className="flex flex-col gap-2 py-3"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium text-fg">{w.workstationName}</span>
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
            </div>
            {w.paused && (
              <Callout
                tone="danger"
                actions={
                  <Button
                    size="sm"
                    disabled={resolve.isPending}
                    aria-label={`Resume sync on ${w.workstationName}`}
                    onClick={() =>
                      resolve.mutate(
                        { id: vault.id, workstationId: w.workstationId },
                        { onSuccess: () => toast.success('Sync resumed') },
                      )
                    }
                  >
                    I resolved it, resume
                  </Button>
                }
              >
                Conflicting files:{' '}
                <span className="font-mono">{w.conflictFiles.join(', ') || 'unknown'}</span>. Resolve them in
                the clone{w.localPath ? ` (${w.localPath})` : ''}, then resume.
              </Callout>
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
  onDone,
}: {
  canWork: boolean;
  canPersonal: boolean;
  projects: Array<{ id: string; key: string; name: string }>;
  onDone: () => void;
}) {
  const register = useRegisterVault();
  const toast = useToast();
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
      {
        onSuccess: () => {
          toast.success('Vault registered');
          setUrl('');
          onDone();
        },
      },
    );
  };
  return (
    <form onSubmit={submit} noValidate aria-label="Register vault" className="flex flex-col gap-4">
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
      <Button type="submit" variant="primary" loading={register.isPending} className="self-end">
        Register vault
      </Button>
    </form>
  );
}
