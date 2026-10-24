import { PACK_PRESETS, type PackDto, type PackPreset, type PacksResponse } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import {
  useAddPack,
  useCheckPack,
  usePackScripts,
  usePacks,
  useRemovePack,
  useRevokePack,
} from '../../api/queries/capabilities.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { formatDateTime } from '../../lib/time.ts';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  Select,
  TextInput,
  useToast,
} from '../ui.tsx';
import { shortSha } from './badges.tsx';
import { TrustReview } from './TrustReview.tsx';
import { UpdateReview } from './UpdateReview.tsx';

/** Packs: git repositories of skills, personas and playbooks, pinned to a commit and used only after the owner approves. */
export function PacksTab() {
  const q = usePacks();
  const [adding, setAdding] = useState(false);
  const [preset, setPreset] = useState<PackPreset | null>(null);
  const packs = q.data?.packs ?? [];
  const presets = PACK_PRESETS.filter((p) => !packs.some((k) => k.preset === p.id));
  return (
    <div className="flex flex-col gap-4" data-testid="packs-tab">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add a pack by git URL
        </Button>
        {presets.map((p) => (
          <Button key={p.id} onClick={() => setPreset(p)} data-testid={`preset-${p.id}`}>
            {p.label}
          </Button>
        ))}
      </div>
      {q.data && q.data.workstationsOnline === 0 && (
        <Callout tone="warning" data-testid="no-workstation">
          No workstation is online. A pack is fetched and read by a workstation, so nothing can be fetched or
          checked until one is.
        </Callout>
      )}
      {q.isPending && <ListSkeleton label="Loading packs" rows={2} />}
      {q.isError && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      <ul className="flex flex-col gap-3" data-testid="packs">
        {packs.map((p) => (
          <li key={p.id} data-testid={`pack-${p.name}`}>
            <PackCard pack={p} />
          </li>
        ))}
      </ul>
      {q.data && packs.length === 0 && (
        <EmptyState
          title="No packs yet"
          description="A pack brings extra skills, personas and playbooks from a git repository. It stays off until you have read it and approved it."
        />
      )}
      {adding && <AddPackDialog workstations={q.data?.workstations ?? []} onClose={() => setAdding(false)} />}
      {preset && (
        <PresetDialog
          preset={preset}
          workstations={q.data?.workstations ?? []}
          onClose={() => setPreset(null)}
        />
      )}
    </div>
  );
}

type PackWorkstation = PacksResponse['workstations'][number];

/**
 * Which workstations fetch and hold a new pack. Packs are cloned and read by a workstation, so the admin says which ones:
 * by default their own. `null` is that default (not sent, so a laptop they pair later holds it too).
 */
function useWorkstationChoice(workstations: PackWorkstation[]) {
  const [chosen, setChosen] = useState<string[] | null>(null);
  const mine = workstations.filter((w) => w.mine).map((w) => w.id);
  const current = chosen ?? mine;
  return {
    current,
    /** The request field: only when the admin changed the default. */
    field: chosen && chosen.length ? { workstationIds: chosen } : {},
    toggle: (id: string) =>
      setChosen(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]),
    valid: workstations.length === 0 || current.some((id) => mine.includes(id)),
  };
}

function WorkstationPicker({
  workstations,
  choice,
}: {
  workstations: PackWorkstation[];
  choice: ReturnType<typeof useWorkstationChoice>;
}) {
  if (workstations.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-1 text-sm" data-testid="pack-workstations">
      <legend className="font-medium">Fetched and read by</legend>
      {workstations.map((w) => (
        <label key={w.id} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={choice.current.includes(w.id)}
            onChange={() => choice.toggle(w.id)}
          />
          <span>
            {w.name}
            {w.mine ? ' (yours)' : ''}
            {w.online ? '' : ', offline'}
          </span>
        </label>
      ))}
      <p className="text-xs text-muted">
        A pack is cloned from a public https URL with no credentials of whoever owns the workstation. Include
        at least one of your own: only your workstation can pin the commit you review.
      </p>
    </fieldset>
  );
}

function AddPackDialog({ workstations, onClose }: { workstations: PackWorkstation[]; onClose: () => void }) {
  const choice = useWorkstationChoice(workstations);
  const add = useAddPack();
  const projects = useProjects();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'org' | 'project'>('org');
  const [projectId, setProjectId] = useState('');
  const ready = url.trim() && ref.trim() && (scope === 'org' || projectId) && choice.valid;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    add.mutate(
      {
        url: url.trim(),
        ref: ref.trim(),
        adapter: 'auto',
        scope,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(scope === 'project' ? { projectId } : {}),
        ...choice.field,
      },
      {
        onSuccess: () => {
          toast.success('Pack added. Review it before anything of it is used.');
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a pack"
      description="Give a public https git URL and a tag, branch or commit. No password or token in the URL: packs are fetched without anyone's git credentials or ssh keys."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="add-pack" disabled={!ready} loading={add.isPending}>
            Add pack
          </Button>
        </>
      }
    >
      <form
        id="add-pack"
        onSubmit={submit}
        className="flex flex-col gap-3"
        aria-label="Add a pack"
        noValidate
      >
        <TextInput
          label="Git URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/example/skills.git"
        />
        <TextInput
          label="Tag, branch or commit"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="v1.0.0"
        />
        <TextInput
          label="Name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          hint="The prefix of its keys, for example bmad gives bmad:analyst. Taken from the URL when empty."
        />
        <Select
          label="Available to"
          value={scope}
          onChange={(e) => setScope(e.target.value as 'org' | 'project')}
        >
          <option value="org">The whole organization</option>
          <option value="project">One project</option>
        </Select>
        {scope === 'project' && (
          <Select label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Choose a project</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.key}: {p.name}
              </option>
            ))}
          </Select>
        )}
        <WorkstationPicker workstations={workstations} choice={choice} />
        <ErrorBox error={add.error} />
      </form>
    </Dialog>
  );
}

function PresetDialog({
  preset,
  workstations,
  onClose,
}: {
  preset: PackPreset;
  workstations: PackWorkstation[];
  onClose: () => void;
}) {
  const choice = useWorkstationChoice(workstations);
  const add = useAddPack();
  const toast = useToast();
  const [ref, setRef] = useState(preset.ref);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={preset.label}
      description={preset.description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ref.trim() || !choice.valid}
            loading={add.isPending}
            onClick={() =>
              add.mutate(
                {
                  name: preset.name,
                  url: preset.url,
                  ref: ref.trim(),
                  adapter: preset.adapter,
                  scope: 'org',
                  preset: preset.id,
                  ...choice.field,
                },
                {
                  onSuccess: () => {
                    toast.success(`${preset.label}: added. Review it before anything of it is used.`);
                    onClose();
                  },
                },
              )
            }
          >
            {preset.label}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm" data-testid="preset-dialog">
        <p data-testid="preset-attribution">{preset.attribution}</p>
        <p>
          Licence: <strong>{preset.license}</strong>. Copyright and permission notice are kept with the
          imported files.
        </p>
        <TextInput label="Version (tag)" value={ref} onChange={(e) => setRef(e.target.value)} />
        <WorkstationPicker workstations={workstations} choice={choice} />
        <Callout tone="info">
          Adding it does not turn anything on. It stays untrusted until you review it and approve the exact
          commit.
        </Callout>
        <ErrorBox error={add.error} />
      </div>
    </Dialog>
  );
}

function PackCard({ pack }: { pack: PackDto }) {
  const check = useCheckPack();
  const revoke = useRevokePack();
  const scripts = usePackScripts();
  const remove = useRemovePack();
  const toast = useToast();
  const projects = useProjects();
  const [reviewing, setReviewing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [newRef, setNewRef] = useState('');
  const [confirm, setConfirm] = useState<'remove' | 'revoke' | 'scripts' | null>(null);
  const project = projects.data?.find((p) => p.id === pack.projectId);
  const ready = pack.status === 'ready';
  const err = check.error ?? revoke.error ?? scripts.error ?? remove.error;
  const quickCheck = () =>
    check.mutate(
      { id: pack.id },
      { onSuccess: () => toast.success('Checking. A workstation looks and the result appears here.') },
    );
  const doCheck = () =>
    check.mutate(
      { id: pack.id, ...(newRef.trim() ? { ref: newRef.trim() } : {}) },
      {
        onSuccess: () => {
          toast.success('Checking. A workstation looks and the result appears here.');
          setChecking(false);
          setNewRef('');
        },
      },
    );
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold text-fg">{pack.name}</h3>
        {pack.status === 'pending' && <Badge tone="amber">waiting for a workstation</Badge>}
        {pack.status === 'failed' && <Badge tone="red">failed</Badge>}
        {ready && <Badge tone="green">ready</Badge>}
        {pack.trusted ? (
          <Badge tone="green" data-testid="trusted">
            trusted
          </Badge>
        ) : (
          <Badge tone="amber" data-testid="untrusted">
            untrusted
          </Badge>
        )}
        {pack.scope === 'project' && <Badge tone="violet">project{project ? `: ${project.key}` : ''}</Badge>}
        {pack.hasScripts && <Badge tone="amber">has scripts</Badge>}
        {pack.scriptsEnabled && <Badge tone="red">scripts on</Badge>}
      </div>
      <p className="mt-1 text-sm text-muted [overflow-wrap:anywhere]">
        {pack.url} at <code>{pack.ref}</code>
        {pack.pinnedSha && (
          <>
            , commit <code data-testid="pinned-sha">{shortSha(pack.pinnedSha)}</code>
          </>
        )}
        {pack.license && <>, licence {pack.license}</>}
        {ready && <>, {pack.itemCount} capabilities</>}
      </p>
      {pack.attribution && <p className="mt-1 text-xs text-muted">{pack.attribution}</p>}
      {pack.lastCheckedAt && (
        <p className="mt-1 text-xs text-subtle">Last checked {formatDateTime(pack.lastCheckedAt)}.</p>
      )}
      {pack.status === 'failed' && pack.error && (
        <Callout tone="danger" className="mt-2">
          {pack.error}
        </Callout>
      )}
      {pack.integrityFailed && (
        <Callout tone="danger" className="mt-2" role="alert" data-testid="integrity-failed">
          The files on disk changed since you approved this pack, so the pack is disabled. Revoke the approval
          and review it again, or remove it.
        </Callout>
      )}
      {pack.update && (
        <Callout
          tone="info"
          className="mt-2"
          data-testid="update-available"
          actions={
            <Button size="sm" variant="primary" onClick={() => setUpdating(true)}>
              Review update
            </Button>
          }
        >
          An update is available: {pack.update.ref} at {shortSha(pack.update.sha)}.
          {(pack.update.diff.scriptsAdded.length > 0 || pack.update.diff.scriptsChanged.length > 0) &&
            ' It adds or changes script files.'}
        </Callout>
      )}
      {pack.trusted && pack.hasScripts && (
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={pack.scriptsEnabled}
            disabled={scripts.isPending}
            onChange={(e) =>
              e.target.checked ? setConfirm('scripts') : scripts.mutate({ id: pack.id, enabled: false })
            }
          />
          Allow this pack's scripts
        </label>
      )}
      {checking && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <TextInput
            label="New tag, branch or commit (optional)"
            value={newRef}
            onChange={(e) => setNewRef(e.target.value)}
            placeholder={pack.ref}
          />
          <Button variant="primary" loading={check.isPending} onClick={doCheck}>
            Check
          </Button>
          <Button variant="ghost" onClick={() => setChecking(false)}>
            Cancel
          </Button>
        </div>
      )}
      <ErrorBox error={err} />
      <div className="mt-3 flex flex-wrap gap-2">
        {!pack.trusted && ready && (
          <Button variant="primary" onClick={() => setReviewing(true)}>
            Review and approve
          </Button>
        )}
        <Button onClick={quickCheck} loading={check.isPending && !checking} data-testid="check-updates">
          Check for updates
        </Button>
        <Button
          variant="ghost"
          onClick={() => setChecking(true)}
          disabled={checking}
          data-testid="check-other"
        >
          Check another tag…
        </Button>
        {pack.trusted && <Button onClick={() => setConfirm('revoke')}>Revoke approval</Button>}
        <Button variant="danger-ghost" onClick={() => setConfirm('remove')}>
          Remove
        </Button>
      </div>
      {reviewing && <TrustReview pack={pack} onClose={() => setReviewing(false)} />}
      {updating && <UpdateReview pack={pack} onClose={() => setUpdating(false)} />}
      <ConfirmDialog
        open={confirm === 'remove'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Remove ${pack.name}?`}
        description="Its capabilities leave the registry. A role that was given one of its skills loses it."
        confirmLabel="Remove pack"
        pending={remove.isPending}
        onConfirm={() => remove.mutate(pack.id, { onSuccess: () => setConfirm(null) })}
      />
      <ConfirmDialog
        open={confirm === 'revoke'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Revoke approval of ${pack.name}?`}
        description="Its capabilities stop being offered and used until you approve it again."
        confirmLabel="Revoke approval"
        pending={revoke.isPending}
        onConfirm={() => revoke.mutate(pack.id, { onSuccess: () => setConfirm(null) })}
      />
      <ConfirmDialog
        open={confirm === 'scripts'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Allow the scripts of ${pack.name}?`}
        description="Scripts run only inside the sandbox on a workstation, and never for turns that talk to a model directly. Only switch this on if you read them."
        confirmLabel="Allow scripts"
        pending={scripts.isPending}
        onConfirm={() =>
          scripts.mutate({ id: pack.id, enabled: true }, { onSuccess: () => setConfirm(null) })
        }
      />
    </div>
  );
}
