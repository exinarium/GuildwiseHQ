import {
  CONNECTABLE_FORGES,
  type ConnectableForge,
  CREATE_FIELDS,
  cloneUrlFor,
  createNameFor,
  detectForgeKind,
  FORGE_KINDS,
  FORGE_LABELS,
  type ForgeKind,
  GIT_ACCESS_LABELS,
  isSafeProjectPath,
  type RepoRef,
} from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useRepoPicker } from '../api/queries/forges.ts';
import { useAddRepo } from '../api/queries/projects.ts';
import { useWorkstations } from '../api/queries/workstations.ts';
import { useExpertMode } from '../lib/expert-mode.ts';
import { ConnectHelper, ConnectionBadge, connectionOf } from './GitConnections.tsx';
import { Button, ErrorBox, Select, TextInput, useToast } from './ui.tsx';

const isConnectable = (k: ForgeKind): k is ConnectableForge =>
  (CONNECTABLE_FORGES as readonly string[]).includes(k);

/**
 * Adds a repository to a project: paste a URL (the provider is detected, with a manual override), pick one from the
 * connected provider (listed by the workstation), or create a new one with the provider's own owner/namespace/project
 * fields. The git provider is chosen per repository: one project may mix GitHub, Azure DevOps and Bitbucket.
 */
export function AddRepoForm({ projectId, onError }: { projectId: string; onError?: (e: unknown) => void }) {
  const addRepo = useAddRepo(projectId);
  const toast = useToast();
  const workstations = useWorkstations();
  const expert = useExpertMode();
  const [mode, setMode] = useState<'clone' | 'create'>('clone');
  const [repoName, setRepoName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [repoBranch, setRepoBranch] = useState('');
  const [repoMain, setRepoMain] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [accessMethod, setAccessMethod] = useState<'default' | 'https' | 'ssh'>('default');
  const [override, setOverride] = useState<ForgeKind | 'auto'>('auto');
  const [createKind, setCreateKind] = useState<ForgeKind>('github');
  const [parts, setParts] = useState<Record<string, string>>({});
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState('');

  const detected = repoUrl.trim() ? detectForgeKind(repoUrl.trim()) : null;
  const kind: ForgeKind =
    mode === 'create' ? createKind : override === 'auto' ? (detected ?? 'git') : override;
  const spec = CREATE_FIELDS[kind];

  // The workstation that answers for this user: the first one that is connected.
  const list = workstations.data ?? [];
  const ws = list.find((w) => w.connected) ?? list[0];
  const conn = isConnectable(kind) ? connectionOf(ws, kind) : undefined;
  const [pickerProvider, setPickerProvider] = useState<ConnectableForge>('github');
  const pickProvider: ConnectableForge = isConnectable(kind) ? kind : pickerProvider;
  const picker = useRepoPicker(ws?.id, pickProvider);

  const use = (r: RepoRef) => {
    setRepoUrl(r.cloneUrl);
    setRepoName(r.fullName.split('/').pop() ?? r.fullName);
    if (r.defaultBranch && !repoBranch) setRepoBranch(r.defaultBranch);
    if (r.defaultBranch && !repoMain) setRepoMain(r.defaultBranch);
    setOverride('auto');
    setPicking(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    const creating = mode === 'create';
    let fullName = '';
    if (creating) {
      const r = createNameFor(
        kind,
        spec.parts.map((p) => parts[p.key] ?? ''),
      );
      if (r.ok) fullName = r.fullName;
      else next.create = r.error;
    }
    const name = repoName.trim() || (creating ? (fullName.split('/').pop() ?? '') : '');
    if (!name && !next.create) next.name = 'Repository name is required';
    if (!creating && !repoUrl.trim()) next.url = 'Remote URL is required';
    if (!isSafeProjectPath(projectPath))
      next.path = 'Use a folder inside the repository, like src/app (no "..", no leading "/").';
    setErrs(next);
    if (Object.keys(next).length) return;
    addRepo.mutate(
      {
        name,
        remoteUrl: creating ? cloneUrlFor(kind, fullName) : repoUrl.trim(),
        ...(repoBranch.trim() ? { workingBranch: repoBranch.trim() } : {}),
        ...(repoMain.trim() ? { mainBranch: repoMain.trim() } : {}),
        ...(projectPath.trim() ? { projectPath: projectPath.trim() } : {}),
        ...(accessMethod !== 'default' ? { accessMethod } : {}),
        ...(creating ? { forge: kind } : override !== 'auto' ? { forge: override } : {}),
        ...(creating ? { create: { name: fullName, visibility } } : {}),
      },
      {
        onSuccess: () => {
          toast.success(
            creating
              ? 'Repository added: the DevOps engineer creates it'
              : 'Repository added: the DevOps engineer clones it',
          );
          setRepoName('');
          setRepoUrl('');
          setRepoBranch('');
          setRepoMain('');
          setProjectPath('');
          setAccessMethod('default');
          setParts({});
          setOverride('auto');
        },
        onError,
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Add repository"
      className="grid gap-4 border-t border-line pt-4 sm:grid-cols-3"
    >
      <fieldset className="flex flex-wrap gap-4 text-sm sm:col-span-3">
        <legend className="mb-1 font-medium">What to add</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="repo-mode" checked={mode === 'clone'} onChange={() => setMode('clone')} />
          An existing repository (cloned onto the workstations)
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="repo-mode"
            checked={mode === 'create'}
            onChange={() => setMode('create')}
          />
          Create a new repository
        </label>
      </fieldset>

      {mode === 'clone' ? (
        <>
          <TextInput
            label="Remote URL"
            hint="HTTPS or SSH, from any git host."
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            error={errs.url}
          />
          <Select
            label="Git host"
            value={override}
            onChange={(e) => setOverride(e.target.value as ForgeKind | 'auto')}
            hint={
              override === 'auto'
                ? detected
                  ? `Detected: ${FORGE_LABELS[detected]}`
                  : 'Detected from the URL'
                : 'Chosen by you (use this for a self-hosted server we cannot recognise)'
            }
          >
            <option value="auto">Detect from the URL</option>
            {FORGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {FORGE_LABELS[k]}
              </option>
            ))}
          </Select>
          <TextInput
            label="Repository name"
            value={repoName}
            onChange={(e) => setRepoName(e.target.value)}
            error={errs.name}
          />
        </>
      ) : (
        <>
          <Select
            label="Git host"
            value={createKind}
            onChange={(e) => {
              setCreateKind(e.target.value as ForgeKind);
              setParts({});
            }}
          >
            {FORGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {FORGE_LABELS[k]}
              </option>
            ))}
          </Select>
          {spec.canCreate ? (
            <>
              {spec.parts.map((p) => (
                <TextInput
                  key={p.key}
                  label={p.label}
                  placeholder={p.placeholder}
                  value={parts[p.key] ?? ''}
                  onChange={(e) => setParts({ ...parts, [p.key]: e.target.value })}
                />
              ))}
              <Select
                label="Visibility"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as 'private' | 'public')}
              >
                <option value="private">Private</option>
                <option value="public">Public</option>
              </Select>
              <TextInput
                label="Repository name (shown here)"
                hint="Leave empty to use the name from the fields above."
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                error={errs.name}
              />
              {errs.create && (
                <p role="alert" className="text-sm font-medium text-danger sm:col-span-3">
                  {errs.create}
                </p>
              )}
              <p className="text-xs text-subtle sm:col-span-3">
                {spec.hint} It is created with the {FORGE_LABELS[kind]} login on the DevOps engineer&apos;s
                workstation, then cloned.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted sm:col-span-2">{spec.hint}</p>
          )}
        </>
      )}

      {isConnectable(kind) && ws && (
        <div className="text-sm sm:col-span-3" data-testid="repo-form-connection">
          <span className="mr-2 font-medium">
            {FORGE_LABELS[kind]} on {ws.name}:
          </span>
          <ConnectionBadge c={conn} />
          {conn?.state !== 'connected' && (
            <ConnectHelper
              provider={kind}
              workstationId={ws.id}
              {...(conn?.host ? { host: conn.host } : {})}
            />
          )}
        </div>
      )}

      {mode === 'clone' && ws && (
        <div className="sm:col-span-3">
          <Button type="button" variant="secondary" size="sm" onClick={() => setPicking(!picking)}>
            {picking ? 'Close the list' : 'Pick from my repositories'}
          </Button>
          {picking && (
            <div className="mt-3 rounded-control border border-line p-3" data-testid="repo-picker">
              <div className="flex flex-wrap items-end gap-3">
                {!isConnectable(kind) && (
                  <Select
                    label="Provider"
                    value={pickerProvider}
                    onChange={(e) => setPickerProvider(e.target.value as ConnectableForge)}
                  >
                    {CONNECTABLE_FORGES.map((k) => (
                      <option key={k} value={k}>
                        {FORGE_LABELS[k]}
                      </option>
                    ))}
                  </Select>
                )}
                <TextInput label="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
                <Button
                  type="button"
                  size="sm"
                  loading={picker.start.isPending || picker.result?.state === 'pending'}
                  onClick={() => picker.start.mutate(search)}
                >
                  List repositories
                </Button>
              </div>
              <p className="mt-2 text-xs text-subtle">
                Listed by {ws.name} with its {FORGE_LABELS[pickProvider]} login.
              </p>
              <ErrorBox error={picker.start.error} />
              {picker.result?.state === 'failed' && (
                <p role="alert" className="mt-2 text-sm text-danger">
                  {picker.result.error ?? 'The workstation could not list repositories.'}
                </p>
              )}
              {picker.result?.state === 'done' && (
                <ul className="mt-2 flex max-h-64 flex-col divide-y divide-line overflow-auto text-sm">
                  {picker.result.repos.length === 0 && (
                    <li className="py-2 text-subtle">No repositories found.</li>
                  )}
                  {picker.result.repos.map((r) => (
                    <li key={r.cloneUrl} className="flex items-center justify-between gap-2 py-2">
                      <span className="min-w-0 break-all">
                        {r.fullName}
                        {r.private !== undefined && (
                          <span className="ml-2 text-xs text-subtle">{r.private ? 'private' : 'public'}</span>
                        )}
                      </span>
                      <Button type="button" size="sm" variant="secondary" onClick={() => use(r)}>
                        Use
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <TextInput
        label="Project path (optional)"
        hint="The folder inside the repository the app lives in, like src/app. Leave empty when it is at the top."
        value={projectPath}
        onChange={(e) => setProjectPath(e.target.value)}
        error={errs.path}
      />
      <Select
        label="Access"
        value={accessMethod}
        onChange={(e) => setAccessMethod(e.target.value as 'default' | 'https' | 'ssh')}
        hint="How the workstation reaches the repository. SSH needs a key set up under Workstations, Git hosts; pull requests still need the API token or CLI login."
      >
        <option value="default">Workstation default</option>
        <option value="https">{GIT_ACCESS_LABELS.https}</option>
        <option value="ssh">{GIT_ACCESS_LABELS.ssh}</option>
      </Select>
      {expert && (
        <TextInput
          label="Main branch (optional)"
          hint="Where pull requests go. Leave empty and the repository's default branch is used."
          value={repoMain}
          onChange={(e) => setRepoMain(e.target.value)}
        />
      )}
      {expert && (
        <TextInput
          label="Working branch (optional)"
          hint="Where finished card work is combined. Leave empty and the repository's default branch is used; a branch that does not exist is created from the main branch."
          value={repoBranch}
          onChange={(e) => setRepoBranch(e.target.value)}
        />
      )}
      <div className="sm:col-span-3">
        <ErrorBox error={addRepo.error} />
      </div>
      <Button
        type="submit"
        variant="primary"
        className="justify-self-start sm:col-span-3"
        loading={addRepo.isPending}
      >
        Add repository
      </Button>
    </form>
  );
}
