import {
  type ConvertCardDecision,
  type ConvertRepo,
  type ProjectDto,
  type ProjectRepoDto,
  type WorkflowDefinition,
  workflowUsesRepos,
} from '@aom/shared';
import { GitBranch, Plus, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useWorkflows } from '../api/queries/agents.ts';
import { useConvertPreview, useConvertProject } from '../api/queries/projects.ts';
import { Badge, Button, Callout, cx, Dialog, ErrorBox, Select, Spinner, TextInput, useToast } from './ui.tsx';

type RepoEntry =
  | { id: number; kind: 'url'; name: string; remoteUrl: string; workingBranch: string }
  | { id: number; kind: 'create'; name: string; visibility: 'private' | 'public'; description: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The latest version of each workflow the project could be converted to (feed and code-bugfix are never targets). */
function targets(all: WorkflowDefinition[], currentKey: string): WorkflowDefinition[] {
  const latest = new Map<string, WorkflowDefinition>();
  for (const d of all) {
    if (d.fieldSet === 'feed' || d.key === 'code-bugfix' || d.key === currentKey) continue;
    const had = latest.get(d.key);
    if (!had || d.version > had.version) latest.set(d.key, d);
  }
  return [...latest.values()].sort(
    (a, b) => Number(b.key === 'code') - Number(a.key === 'code') || a.name.localeCompare(b.name),
  );
}

/**
 * Convert a project to another workflow (docs/design/restructure.md section 8; Owner and Admins). Four short steps in
 * one scrolling dialog: the workflow, the repositories (existing, or a new one the owner approves on the desk), what
 * happens to the open cards the new workflow cannot place, and an optional note. The preview from the server shows the
 * cards, so nothing here is guessed.
 */
export function ConvertProjectDialog({
  project,
  repos,
  open,
  onOpenChange,
}: {
  project: ProjectDto;
  repos: ProjectRepoDto[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const workflows = useWorkflows(project.id);
  const options = useMemo(
    () => targets(workflows.data?.map((w) => w.definition) ?? [], project.workflowKey),
    [workflows.data, project.workflowKey],
  );
  const [toKey, setToKey] = useState<string | null>(null);
  const [entries, setEntries] = useState<RepoEntry[]>([]);
  const [defaultDecision, setDefaultDecision] = useState<ConvertCardDecision>('keep');
  const [overrides, setOverrides] = useState<Record<string, ConvertCardDecision>>({});
  const [note, setNote] = useState('');
  const [urlName, setUrlName] = useState('');
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [newName, setNewName] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [formErr, setFormErr] = useState<Record<string, string>>({});
  const convert = useConvertProject(project.id);
  const toast = useToast();

  // The usual next step is preselected (code, for a research project) once the catalogue is known.
  useEffect(() => {
    if (!open || toKey || options.length === 0) return;
    setToKey((options.find((o) => o.key === 'code') ?? options[0])?.key ?? null);
  }, [open, toKey, options]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on close only
  useEffect(() => {
    if (open) return;
    setToKey(null);
    setEntries([]);
    setOverrides({});
    setDefaultDecision('keep');
    setNote('');
    convert.reset();
  }, [open]);

  const target = options.find((o) => o.key === toKey);
  const preview = useConvertPreview(project.id, toKey, open);
  const usesRepos = target ? workflowUsesRepos(target) : false;
  const activeRepos = repos.filter((r) => !r.removedAt);
  const haveRepoNow = activeRepos.length + entries.filter((e) => e.kind === 'url').length > 0;
  const needsRepo = usesRepos && !haveRepoNow && !entries.some((e) => e.kind === 'create');
  const waitingForRepo = usesRepos && !haveRepoNow && entries.some((e) => e.kind === 'create');
  const started = project.startedAs ?? project.workflowKey;

  const addUrl = () => {
    const errs: Record<string, string> = {};
    if (!urlName.trim()) errs.urlName = 'Give the repository a name';
    if (!url.trim() || /\s/.test(url.trim())) errs.url = 'Enter the git remote URL, without spaces';
    setFormErr(errs);
    if (Object.keys(errs).length) return;
    setEntries((e) => [
      ...e,
      {
        id: Date.now(),
        kind: 'url',
        name: urlName.trim(),
        remoteUrl: url.trim(),
        workingBranch: branch.trim(),
      },
    ]);
    setUrlName('');
    setUrl('');
    setBranch('');
  };
  const addCreate = () => {
    const errs: Record<string, string> = {};
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(newName.trim()))
      errs.newName = 'Use owner/repo, for example acme/shop';
    setFormErr(errs);
    if (Object.keys(errs).length) return;
    setEntries((e) => [
      ...e,
      { id: Date.now(), kind: 'create', name: newName.trim(), visibility, description: '' },
    ]);
    setNewName('');
  };

  const submit = () => {
    if (!toKey) return;
    const reposBody: ConvertRepo[] = entries.map((e) =>
      e.kind === 'url'
        ? {
            name: e.name,
            remoteUrl: e.remoteUrl,
            ...(e.workingBranch ? { workingBranch: e.workingBranch } : {}),
          }
        : {
            create: {
              name: e.name,
              visibility: e.visibility,
              ...(e.description ? { description: e.description } : {}),
            },
          },
    );
    convert.mutate(
      {
        toWorkflowKey: toKey,
        repos: reposBody,
        defaultDecision,
        cardDecisions: overrides,
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      {
        onSuccess: (r) => {
          toast.success(
            r.status === 'waiting'
              ? 'Repository requested: the project converts once you approve it on the desk'
              : `${project.name} converted`,
          );
          onOpenChange(false);
        },
      },
    );
  };

  const foreign = preview.data?.foreignCards ?? [];
  const decisionOf = (id: string) => overrides[id] ?? defaultDecision;
  const cancelCount = foreign.filter((c) => decisionOf(c.id) === 'cancel').length;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={`Convert ${project.name}`}
      description={
        started === 'research'
          ? `${project.key} started as research${project.publishedNotes ? ` and has ${plural(project.publishedNotes, 'published note')}` : ''}. Its cards, notes and history are kept.`
          : 'Its cards, notes and history are kept.'
      }
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            data-testid="convert-submit"
            loading={convert.isPending}
            disabled={!toKey || !preview.data || needsRepo}
            onClick={submit}
          >
            {waitingForRepo ? 'Request the repository' : 'Convert project'}
          </Button>
        </>
      }
    >
      <div data-testid="convert-dialog" className="flex flex-col gap-6">
        <section aria-labelledby="convert-step-workflow" className="flex flex-col gap-2">
          <h3 id="convert-step-workflow" className="text-sm font-semibold text-fg">
            1. Workflow
          </h3>
          {workflows.isPending && <Spinner inline label="Loading workflows" />}
          <div role="radiogroup" aria-label="Target workflow" className="flex flex-col gap-2">
            {options.map((o) => {
              const on = o.key === toKey;
              return (
                <label
                  key={o.key}
                  data-testid={`convert-workflow-${o.key}`}
                  className={cx(
                    'flex cursor-pointer items-start gap-3 rounded-card border p-3',
                    on ? 'border-brand bg-brand-soft' : 'border-control hover:bg-sunken',
                  )}
                >
                  <input
                    type="radio"
                    name="convert-workflow"
                    className="mt-1 size-4 accent-brand"
                    checked={on}
                    onChange={() => setToKey(o.key)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2 font-medium text-fg">
                      {o.name}
                      {!o.builtIn && <Badge>custom</Badge>}
                      {project.workflowKey === 'research' && o.key === 'code' && (
                        <Badge tone="brand" icon={<Sparkles aria-hidden="true" className="size-3" />}>
                          Usual next step
                        </Badge>
                      )}
                    </span>
                    <span className="block text-sm text-muted">
                      {workflowUsesRepos(o)
                        ? 'Works in repositories: builders, reviewers and testers.'
                        : 'Works in the project vault: no repository needed.'}
                    </span>
                  </span>
                </label>
              );
            })}
            {!workflows.isPending && options.length === 0 && (
              <p className="text-sm text-muted">There is no other workflow to convert to.</p>
            )}
          </div>
          {project.workflowKey === 'research' && (
            <p className="text-sm text-muted">
              A research project usually becomes a code project once the questions are answered: the notes are
              listed in PROJECT.md so every agent reads them.
            </p>
          )}
        </section>

        {usesRepos && (
          <section aria-labelledby="convert-step-repos" className="flex flex-col gap-3">
            <h3 id="convert-step-repos" className="text-sm font-semibold text-fg">
              2. Repositories
            </h3>
            <p className="text-sm text-muted">
              The {target?.name} workflow works in repositories: add at least one. For each new repository the
              DevOps engineer then asks which branch is the working branch.
            </p>
            {activeRepos.length > 0 && (
              <ul className="text-sm" data-testid="convert-existing-repos">
                {activeRepos.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 py-0.5">
                    <GitBranch aria-hidden="true" className="size-4 text-subtle" />
                    <span className="font-medium">{r.name}</span>
                    <span className="truncate font-mono text-xs text-subtle">{r.remoteUrl}</span>
                  </li>
                ))}
              </ul>
            )}
            {entries.length > 0 && (
              <ul className="flex flex-col gap-1" data-testid="convert-repo-entries">
                {entries.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-center gap-2 rounded-control border border-line bg-sunken px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{e.name}</span>{' '}
                      {e.kind === 'url' ? (
                        <span className="font-mono text-xs break-all text-subtle">{e.remoteUrl}</span>
                      ) : (
                        <Badge tone="warning">new on GitHub, {e.visibility}: needs your approval</Badge>
                      )}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${e.name}`}
                      onClick={() => setEntries((l) => l.filter((x) => x.id !== e.id))}
                    >
                      <X aria-hidden="true" className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="grid gap-3 rounded-card border border-line p-3 sm:grid-cols-3">
              <p className="text-sm font-medium sm:col-span-3">Add an existing repository</p>
              <TextInput
                label="Name"
                value={urlName}
                onChange={(e) => setUrlName(e.target.value)}
                error={formErr.urlName}
                data-testid="convert-repo-name"
              />
              <TextInput
                label="Remote URL"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                error={formErr.url}
                data-testid="convert-repo-url"
              />
              <TextInput
                label="Branch (optional)"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                data-testid="convert-repo-branch"
              />
              <Button
                className="justify-self-start sm:col-span-3"
                data-testid="convert-repo-add"
                onClick={addUrl}
              >
                <Plus aria-hidden="true" className="size-4" />
                Add repository
              </Button>
            </div>
            <div className="grid gap-3 rounded-card border border-line p-3 sm:grid-cols-3">
              <p className="text-sm font-medium sm:col-span-3">Or request a new GitHub repository</p>
              <TextInput
                label="Owner and name"
                placeholder="acme/shop"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                error={formErr.newName}
                data-testid="convert-new-name"
              />
              <Select
                label="Visibility"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as 'private' | 'public')}
                data-testid="convert-new-visibility"
              >
                <option value="private">Private</option>
                <option value="public">Public</option>
              </Select>
              <div className="flex items-end">
                <Button data-testid="convert-new-add" onClick={addCreate}>
                  <Plus aria-hidden="true" className="size-4" />
                  Request repository
                </Button>
              </div>
              <p className="text-xs text-subtle sm:col-span-3">
                An approval lands on the desk. When you approve it, your runner creates the repository with
                your GitHub login and the project gets it.
              </p>
            </div>
            {needsRepo && (
              <Callout tone="warning" data-testid="convert-needs-repo">
                Add a repository, or request a new one, to convert to {target?.name}.
              </Callout>
            )}
            {waitingForRepo && (
              <Callout tone="info" data-testid="convert-waiting-note">
                The project converts as soon as the new repository exists: nothing changes before you approve
                it on the desk.
              </Callout>
            )}
          </section>
        )}

        <section aria-labelledby="convert-step-cards" className="flex flex-col gap-3">
          <h3 id="convert-step-cards" className="text-sm font-semibold text-fg">
            {usesRepos ? '3' : '2'}. Open cards
          </h3>
          {preview.isPending && toKey && <Spinner inline label="Checking the open cards" />}
          {preview.isError && <ErrorBox error={preview.error} />}
          {preview.data && foreign.length === 0 && (
            <p className="text-sm text-muted" data-testid="convert-no-cards">
              Every open card fits the {preview.data.toWorkflowName} workflow: nothing to decide.
            </p>
          )}
          {preview.data && foreign.length > 0 && (
            <>
              <p className="text-sm text-muted">
                {plural(foreign.length, 'open card')} run on another workflow. Kept cards finish where they
                are and show in their own board columns; cancelled ones are closed with the reason "Project
                converted".
              </p>
              <div role="radiogroup" aria-label="Open cards" className="flex flex-col gap-2">
                {(['keep', 'cancel'] as const).map((d) => (
                  <label
                    key={d}
                    data-testid={`convert-default-${d}`}
                    className={cx(
                      'flex cursor-pointer items-start gap-3 rounded-card border p-3',
                      defaultDecision === d ? 'border-brand bg-brand-soft' : 'border-control hover:bg-sunken',
                    )}
                  >
                    <input
                      type="radio"
                      name="convert-default"
                      className="mt-1 size-4 accent-brand"
                      checked={defaultDecision === d}
                      onChange={() => {
                        setDefaultDecision(d);
                        setOverrides({});
                      }}
                    />
                    <span>
                      <span className="block font-medium text-fg">
                        {d === 'keep' ? 'Keep them running' : 'Cancel them'}
                      </span>
                      <span className="block text-sm text-muted">
                        {d === 'keep'
                          ? 'They finish on their own workflow, as before.'
                          : 'Running shifts stop and the cards are closed.'}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <ul
                className="divide-y divide-line rounded-card border border-line"
                data-testid="convert-cards"
              >
                {foreign.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <span className="font-mono text-xs text-subtle">{c.ref}</span>
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    {c.claimed && <Badge tone="info">in progress</Badge>}
                    <Select
                      label={`Decision for ${c.ref}`}
                      value={decisionOf(c.id)}
                      onChange={(e) =>
                        setOverrides((o) => ({ ...o, [c.id]: e.target.value as ConvertCardDecision }))
                      }
                      className="h-8 min-h-8 w-28 py-0 text-sm"
                      data-testid={`convert-card-${c.ref}`}
                    >
                      <option value="keep">Keep</option>
                      <option value="cancel">Cancel</option>
                    </Select>
                  </li>
                ))}
              </ul>
              <p className="text-sm font-medium" data-testid="convert-summary">
                {plural(foreign.length - cancelCount, 'card')} kept, {plural(cancelCount, 'card')} cancelled.
              </p>
            </>
          )}
          {preview.data && preview.data.placedCards > 0 && (
            <p className="text-xs text-subtle">
              {plural(preview.data.placedCards, 'card')} already run on this workflow.
            </p>
          )}
        </section>

        <section aria-labelledby="convert-step-note" className="flex flex-col gap-2">
          <h3 id="convert-step-note" className="text-sm font-semibold text-fg">
            {usesRepos ? '4' : '3'}. Hand-over
          </h3>
          {(preview.data?.publishedNotes ?? 0) > 0 && (
            <p className="text-sm text-muted" data-testid="convert-handover">
              {plural(preview.data?.publishedNotes ?? 0, 'research note')} will be listed in PROJECT.md of the
              project vault, so every agent reads them.
            </p>
          )}
          <TextInput
            label="Note (optional)"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            data-testid="convert-note"
          />
        </section>

        <ErrorBox error={convert.error} />
        <p className="text-xs text-subtle">
          Converting changes how the project works from now on. Cards, notes and history are kept.
        </p>
      </div>
    </Dialog>
  );
}
