import type { MyPackDto, PackVisibility } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useAgents } from '../../api/queries/agents.ts';
import {
  readMyPackTree,
  useCreateMyPack,
  useGrantPackAgent,
  useMyPacks,
  useRemoveMyPack,
  useSaveMyPack,
  useSetMyPackVisibility,
} from '../../api/queries/my-capabilities.ts';
import { useCanManageOrg } from '../../lib/orgRole.ts';
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
  TextArea,
  TextInput,
  useToast,
} from '../ui.tsx';
import { downloadPackZip, PackEditor, slugOf } from './CapabilityEditor.tsx';
import { PackAssignments } from './PackAssignments.tsx';

const STATE_LABEL: Record<
  MyPackDto['state'],
  { text: string; tone: 'neutral' | 'amber' | 'green' | 'violet' }
> = {
  draft: { text: 'nothing saved yet', tone: 'neutral' },
  private: { text: 'private to my workstation', tone: 'violet' },
  in_review: { text: 'waiting for an Owner or Admin', tone: 'amber' },
  trusted: { text: 'approved for the organization', tone: 'green' },
};

/** My capabilities: skills, personas and playbooks I author. Each is stored as a real pack, in the same layout as an imported one. */
export function MyCapabilitiesTab() {
  const q = useMyPacks();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const packs = q.data?.packs ?? [];
  return (
    <div className="flex flex-col gap-4" data-testid="my-capabilities-tab">
      <PackAssignments />
      <Callout tone="info">
        What you write here is stored on your workstation as a pack, in the standard layout, so you can export
        it as a git-ready folder and publish it unchanged. A <strong>private</strong> pack stays on your
        workstation: only you see it, and the server never gets its text. An <strong>organization</strong>{' '}
        pack is reviewed by an Owner or Admin like any imported pack before anyone can use it.
      </Callout>
      <div>
        <Button variant="primary" onClick={() => setCreating(true)} data-testid="new-pack">
          New pack
        </Button>
      </div>
      {q.isPending && <ListSkeleton label="Loading your packs" rows={2} />}
      {q.isError && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      <ul className="flex flex-col gap-3" data-testid="my-packs">
        {packs.map((p) => (
          <li key={p.id} data-testid={`my-pack-${p.name}`}>
            <MyPackCard pack={p} editing={editing === p.id} onEdit={(on) => setEditing(on ? p.id : null)} />
          </li>
        ))}
      </ul>
      {q.data && packs.length === 0 && (
        <EmptyState
          title="No packs of your own yet"
          description="Create a pack, then add a skill, a persona or a playbook to it."
        />
      )}
      {creating && (
        <NewPackDialog
          workstations={q.data?.workstations ?? []}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setEditing(id);
          }}
        />
      )}
    </div>
  );
}

function NewPackDialog({
  workstations,
  onClose,
  onCreated,
}: {
  workstations: Array<{ id: string; name: string; online: boolean; supported: boolean }>;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreateMyPack();
  const usable = workstations.filter((w) => w.supported);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<PackVisibility>('private');
  const [workstationId, setWorkstationId] = useState(usable[0]?.id ?? '');
  const ready = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && !!workstationId;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    create.mutate(
      { name, description: description.trim(), visibility, workstationId },
      { onSuccess: (r) => onCreated((r as { pack: MyPackDto }).pack.id) },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New pack"
      description="A pack holds your skills, personas and playbooks. Its name prefixes their keys (mine:reviewer)."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="new-pack-form"
            disabled={!ready}
            loading={create.isPending}
          >
            Create pack
          </Button>
        </>
      }
    >
      <form
        id="new-pack-form"
        onSubmit={submit}
        className="flex flex-col gap-3"
        aria-label="New pack"
        noValidate
      >
        <TextInput
          label="Name"
          value={name}
          onChange={(e) => setName(slugOf(e.target.value))}
          hint="Lowercase letters, digits and hyphens."
        />
        <TextArea
          label="Description (optional)"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <Select
          label="Who can use it"
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as PackVisibility)}
        >
          <option value="private">Private to my workstation</option>
          <option value="org">The organization (after an Owner or Admin approves it)</option>
        </Select>
        <Select label="Stored on" value={workstationId} onChange={(e) => setWorkstationId(e.target.value)}>
          {usable.length === 0 && (
            <option value="">No workstation can author packs yet: update the runner</option>
          )}
          {usable.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {w.online ? '' : ' (offline)'}
            </option>
          ))}
        </Select>
        <ErrorBox error={create.error} />
      </form>
    </Dialog>
  );
}

function MyPackCard({
  pack,
  editing,
  onEdit,
}: {
  pack: MyPackDto;
  editing: boolean;
  onEdit: (on: boolean) => void;
}) {
  const canApprove = useCanManageOrg();
  const save = useSaveMyPack();
  const visibility = useSetMyPackVisibility();
  const remove = useRemoveMyPack();
  const toast = useToast();
  const [tree, setTree] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'visibility' | null>(null);
  const state = STATE_LABEL[pack.state];
  const open = async () => {
    setLoadError(null);
    if (!pack.pinnedSha) {
      setTree({});
      onEdit(true);
      return;
    }
    setLoading(true);
    try {
      setTree(await readMyPackTree(pack.id));
      onEdit(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };
  const exportZip = async () => {
    setLoadError(null);
    setLoading(true);
    try {
      downloadPackZip(pack.name, await readMyPackTree(pack.id));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold text-fg">{pack.name}</h3>
        <Badge tone={state.tone} data-testid="pack-state">
          {state.text}
        </Badge>
        <Badge>{pack.visibility === 'private' ? 'private' : 'organization'}</Badge>
        {pack.hasScripts && <Badge tone="amber">has scripts</Badge>}
        {pack.saving && <Badge tone="blue">saving…</Badge>}
      </div>
      <p className="mt-1 text-sm text-muted">
        {pack.description || 'No description.'} Stored on <strong>{pack.workstationName}</strong>
        {pack.workstationOnline ? '' : ' (offline)'}
        {pack.revision > 0 && <>, revision {pack.revision}</>}.
      </p>
      {pack.items.length > 0 && (
        <p className="mt-1 text-sm text-muted">{pack.items.map((i) => `${i.kind} ${i.key}`).join(', ')}</p>
      )}
      {pack.error && (
        <Callout tone="danger" className="mt-2" data-testid="pack-error">
          {pack.error}
        </Callout>
      )}
      {pack.update && pack.visibility === 'org' && (
        <Callout tone="info" className="mt-2">
          Your latest save waits for an Owner or Admin to review it. The organization keeps using the approved
          revision until then.
        </Callout>
      )}
      {pack.holders.some((h) => h.assignment === 'pending') && (
        <p className="mt-1 text-xs text-muted">
          Waiting for{' '}
          {pack.holders
            .filter((h) => h.assignment === 'pending')
            .map((h) => h.ownerName)
            .join(', ')}{' '}
          to accept the pack on their workstation.
        </p>
      )}
      <ErrorBox error={save.error ?? visibility.error ?? remove.error} />
      {loadError && (
        <Callout tone="warning" className="mt-2" role="alert">
          {loadError}
        </Callout>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {!editing && (
          <Button
            variant="primary"
            onClick={open}
            loading={loading}
            disabled={!pack.supported}
            data-testid="edit-pack"
          >
            {pack.pinnedSha ? 'Edit' : 'Start writing'}
          </Button>
        )}
        {pack.pinnedSha && (
          <Button onClick={exportZip} disabled={loading} data-testid="export-pack">
            Export as zip
          </Button>
        )}
        <Button onClick={() => setConfirm('visibility')} data-testid="toggle-visibility">
          {pack.visibility === 'private' ? 'Share with the organization…' : 'Make private…'}
        </Button>
        <Button variant="danger-ghost" onClick={() => setConfirm('delete')}>
          Delete
        </Button>
      </div>
      {editing && tree && (
        <div className="mt-4 border-t border-line pt-4">
          <PackEditor
            name={pack.name}
            description={pack.description}
            initialTree={tree}
            saving={save.isPending || pack.saving}
            canApprove={pack.mayApprove && canApprove}
            orgVisible={pack.visibility === 'org'}
            onClose={() => onEdit(false)}
            onSave={(t, approve) =>
              save.mutate(
                { id: pack.id, workstationId: pack.workstationId, tree: t, approve },
                {
                  onSuccess: () =>
                    toast.success(
                      'Saved to your workstation. It is checked there and the result appears here.',
                    ),
                },
              )
            }
            extra={pack.visibility === 'private' ? <GrantAgents pack={pack} /> : undefined}
          />
        </div>
      )}
      <ConfirmDialog
        open={confirm === 'visibility'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={
          pack.visibility === 'private'
            ? `Share ${pack.name} with the organization?`
            : `Make ${pack.name} private?`
        }
        description={
          pack.visibility === 'private'
            ? 'It is then listed for an Owner or Admin to review. Nobody can use it until they approve this exact version.'
            : 'It is removed from the organization registry and stays on your workstation. Its approval lapses, and agents hired from it are flagged.'
        }
        tone="primary"
        confirmLabel={pack.visibility === 'private' ? 'Share it' : 'Make private'}
        pending={visibility.isPending}
        onConfirm={() =>
          visibility.mutate(
            { id: pack.id, visibility: pack.visibility === 'private' ? 'org' : 'private' },
            { onSuccess: () => setConfirm(null) },
          )
        }
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete ${pack.name}?`}
        description="Its files are removed from the workstation. Export it first if you want to keep it."
        confirmLabel="Delete pack"
        pending={remove.isPending}
        onConfirm={() => remove.mutate(pack.id, { onSuccess: () => setConfirm(null) })}
      />
    </div>
  );
}

/** A private pack is also usable by the agents of this workstation that its owner grants it to. */
function GrantAgents({ pack }: { pack: MyPackDto }) {
  const agents = useAgents();
  const grant = useGrantPackAgent();
  const here = (agents.data ?? []).filter(
    (a) => a.workstationId === pack.workstationId && a.status !== 'retired',
  );
  return (
    <fieldset className="flex flex-col gap-1 text-sm" data-testid="grant-agents">
      <legend className="font-medium">Agents that may use it</legend>
      <p className="text-xs text-muted">
        Your own sessions on this workstation always can. A card shift of an agent only can when you grant it
        here.
      </p>
      {here.length === 0 && <p className="text-xs text-muted">No agent runs on this workstation.</p>}
      {here.map((a) => (
        <label key={a.id} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={pack.grantedAgentIds.includes(a.id)}
            onChange={(e) => grant.mutate({ id: pack.id, agentId: a.id, granted: e.target.checked })}
          />
          {a.name}
        </label>
      ))}
      <ErrorBox error={grant.error} />
    </fieldset>
  );
}
