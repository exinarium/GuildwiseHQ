import type { PackDto, PacksResponse } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import {
  useAddPack,
  useCheckPack,
  usePackScripts,
  usePacks,
  useRemovePack,
  useRevokePack,
} from '../../api/queries/capabilities.ts';
import { sealPackCredential, useSetPackWorkstations } from '../../api/queries/my-capabilities.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { useBusinessMode } from '../../lib/orgMode.ts';
import { canSealHere, newId } from '../../lib/secure.ts';
import { formatDateTime } from '../../lib/time.ts';
import { SecureContextNotice } from '../SecureContextNotice.tsx';
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
import { shortSha } from './badges.tsx';
import { HirePackDialog } from './HirePackDialog.tsx';
import { PackTeamSection } from './PackTeamSection.tsx';
import { TrustReview } from './TrustReview.tsx';
import { UpdateReview } from './UpdateReview.tsx';

/** Packs: git repositories of skills, personas and playbooks, pinned to a commit and used only after the owner approves. */
export function PacksTab() {
  const q = usePacks();
  const [adding, setAdding] = useState(false);
  const business = useBusinessMode();
  const packs = q.data?.packs ?? [];
  return (
    <div className="flex flex-col gap-4" data-testid="packs-tab">
      {!business && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add a pack by git URL
          </Button>
          <span className="text-xs text-muted" data-testid="packs-format-note">
            Any repository of skills in the Agent Skills format (folders with a SKILL.md) can be added by its
            git URL.
          </span>
        </div>
      )}
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
      {adding && !business && (
        <AddPackDialog workstations={q.data?.workstations ?? []} onClose={() => setAdding(false)} />
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
        A pack is cloned in a clean environment with none of the credentials of whoever owns the workstation.
        Include at least one of your own: only your workstation can pin the commit you review. Another
        member's workstation gets a request on their desk and clones the pack only after they accept.
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
  // a private repository: a deploy key (ssh) or a token (https), sealed in the browser to each chosen workstation
  const [isPrivate, setIsPrivate] = useState(false);
  const [secret, setSecret] = useState('');
  const [username, setUsername] = useState('');
  const [sealing, setSealing] = useState(false);
  const [sealError, setSealError] = useState<string | null>(null);
  // chosen here so a private pack's deploy key or token can be sealed bound to it before it exists
  const [packId] = useState(() => newId());
  const kind: 'ssh' | 'token' = /^(ssh:\/\/|git@)/i.test(url.trim()) ? 'ssh' : 'token';
  const ready =
    url.trim() &&
    ref.trim() &&
    (scope === 'org' || projectId) &&
    choice.valid &&
    (!isPrivate || (secret.trim() && choice.current.length > 0 && canSealHere()));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setSealError(null);
    let credential: Awaited<ReturnType<typeof sealPackCredential>> | undefined;
    if (isPrivate) {
      setSealing(true);
      try {
        credential = await sealPackCredential(
          kind,
          secret.trim(),
          choice.current,
          { id: packId, url: url.trim() },
          kind === 'token' ? username.trim() || undefined : undefined,
        );
      } catch (err) {
        setSealError(err instanceof Error ? err.message : String(err));
        return;
      } finally {
        setSealing(false);
      }
    }
    add.mutate(
      {
        // the id the credential was sealed for
        ...(isPrivate ? { id: packId } : {}),
        url: url.trim(),
        ref: ref.trim(),
        adapter: 'auto',
        scope,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(scope === 'project' ? { projectId } : {}),
        ...(isPrivate
          ? { workstationIds: choice.current, ...(credential ? { credential } : {}) }
          : choice.field),
      },
      {
        onSuccess: () => {
          setSecret('');
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
      description="Give a git URL and a tag, branch or commit. A public https repository needs nothing else; a private one needs a deploy key or token, which is sealed in your browser to the workstations you choose. Never put a password or token in the URL."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="add-pack"
            disabled={!ready}
            loading={add.isPending || sealing}
          >
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
          hint="The prefix of its keys, for example acme gives acme:analyst. Taken from the URL when empty."
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
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
            data-testid="private-repo"
          />
          This is a private repository
        </label>
        {isPrivate && (
          <div
            className="flex flex-col gap-3 rounded-card border border-line p-3"
            data-testid="private-credential"
          >
            <SecureContextNotice />
            <p className="text-sm text-muted">
              {kind === 'ssh'
                ? 'An ssh URL needs a deploy key: the private key, with no passphrase, whose public half is added to the repository as a read-only deploy key.'
                : 'An https URL needs an access token with read access to the repository.'}{' '}
              It is encrypted here for each chosen workstation separately, stored there with permission 0600,
              used only to fetch this pack, and never shown again. The server only relays the encrypted
              copies.
            </p>
            {kind === 'token' && (
              <TextInput
                label="User name (optional)"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                hint="Defaults to x-access-token, which GitHub accepts."
              />
            )}
            <TextArea
              label={kind === 'ssh' ? 'Deploy key (private key)' : 'Access token'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              rows={kind === 'ssh' ? 6 : 2}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted">
              The first fetch over ssh records the host key of the git server and pins it for this pack.
            </p>
          </div>
        )}
        {sealError && <Callout tone="danger">{sealError}</Callout>}
        <ErrorBox error={add.error} />
      </form>
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
  const [hiring, setHiring] = useState(false);
  const [team, setTeam] = useState(false);
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
        {pack.source === 'authored' && (
          <Badge tone="blue" data-testid="authored-badge">
            written by {pack.ownerName ?? 'a member'}
          </Badge>
        )}
        {pack.credentialKind && (
          <Badge tone="violet" data-testid="private-repo-badge">
            private repository ({pack.credentialKind === 'ssh' ? 'deploy key' : 'token'})
          </Badge>
        )}
        {pack.hasScripts && <Badge tone="amber">has scripts</Badge>}
        {pack.scriptsEnabled && <Badge tone="red">scripts on</Badge>}
      </div>
      <p className="mt-1 text-sm text-muted [overflow-wrap:anywhere]">
        {pack.source === 'authored' ? 'Authored in the capability editor' : pack.url} at{' '}
        <code>{pack.ref}</code>
        {pack.pinnedSha && (
          <>
            , commit <code data-testid="pinned-sha">{shortSha(pack.pinnedSha)}</code>
          </>
        )}
        {pack.license && <>, licence {pack.license}</>}
        {ready && <>, {pack.itemCount} capabilities</>}
      </p>
      {pack.attribution && <p className="mt-1 text-xs text-muted">{pack.attribution}</p>}
      {pack.credentialFingerprint && (
        <p className="mt-1 text-xs text-muted" data-testid="key-fingerprint">
          Deploy key fingerprint <code>{pack.credentialFingerprint}</code>: compare it with the key on your
          git host.
        </p>
      )}
      {pack.holders.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-xs text-muted" data-testid="pack-holders">
          {pack.holders.map((h) => (
            <li key={h.workstationId} data-testid={`holder-${h.workstationName}`}>
              <strong>{h.workstationName}</strong> ({h.ownerName}):{' '}
              {h.assignment === 'pending'
                ? `waiting for ${h.ownerName} to accept`
                : h.hasContent
                  ? 'holds the pinned version'
                  : 'accepted'}
              {h.credential &&
                `, key ${h.credential === 'stored' ? 'stored' : h.credential === 'failed' ? `failed (${h.credentialError ?? 'see the runner'})` : 'on its way'}`}
              {pack.credentialKind === 'ssh' &&
                h.credential === 'stored' &&
                (h.hostKeyPinned ? ', host key pinned' : ', host key not pinned yet')}
            </li>
          ))}
        </ul>
      )}
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
        {pack.source !== 'authored' && (
          <>
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
          </>
        )}
        {pack.trusted && pack.visibility === 'private' && (
          <Button variant="primary" onClick={() => setHiring(true)} data-testid="hire-from-pack">
            Hire from this pack…
          </Button>
        )}
        {pack.trusted && pack.visibility !== 'private' && (
          <Button
            variant="primary"
            aria-expanded={team}
            onClick={() => setTeam(!team)}
            data-testid="pack-team-toggle"
          >
            {team ? 'Hide the team' : 'Team and hiring…'}
          </Button>
        )}
        <HoldersButton pack={pack} />
        {pack.trusted && <Button onClick={() => setConfirm('revoke')}>Revoke approval</Button>}
        <Button variant="danger-ghost" onClick={() => setConfirm('remove')}>
          Remove
        </Button>
      </div>
      {team && pack.trusted && <PackTeamSection packId={pack.id} packName={pack.name} pack={pack} />}
      {reviewing && <TrustReview pack={pack} onClose={() => setReviewing(false)} />}
      {hiring && <HirePackDialog packId={pack.id} packName={pack.name} onClose={() => setHiring(false)} />}
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

/** Which workstations hold the pack. A workstation of another member gets a request on their desk first. */
function HoldersButton({ pack }: { pack: PackDto }) {
  const q = usePacks();
  const set = useSetPackWorkstations();
  const [open, setOpen] = useState(false);
  const ws = q.data?.workstations ?? [];
  const [ids, setIds] = useState<string[]>(pack.holders.map((h) => h.workstationId));
  const [secret, setSecret] = useState('');
  const added = ids.filter((id) => !pack.holders.some((h) => h.workstationId === id));
  const needsKey = !!pack.credentialKind && added.length > 0;
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      const credential = needsKey
        ? await sealPackCredential(pack.credentialKind as 'ssh' | 'token', secret.trim(), ids, {
            id: pack.id,
            url: pack.url,
          })
        : undefined;
      set.mutate(
        { id: pack.id, workstationIds: ids, ...(credential ? { credential } : {}) },
        {
          onSuccess: () => {
            setSecret('');
            setOpen(false);
          },
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="pack-holders-edit">
        Workstations…
      </Button>
      {open && (
        <Dialog
          open
          onOpenChange={(o) => !o && setOpen(false)}
          title={`Where ${pack.name} lives`}
          description="A workstation of another member is asked first and clones the pack only after they accept."
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={set.isPending}
                disabled={ids.length === 0 || (needsKey && (!secret.trim() || !canSealHere()))}
                onClick={save}
              >
                Save
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2 text-sm">
            {ws.map((w) => (
              <label key={w.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={ids.includes(w.id)}
                  disabled={pack.source === 'authored' && pack.holders[0]?.workstationId === w.id}
                  onChange={() => setIds(ids.includes(w.id) ? ids.filter((x) => x !== w.id) : [...ids, w.id])}
                />
                {w.name}
                {w.mine ? ' (yours)' : ''}
              </label>
            ))}
            {needsKey && (
              <TextArea
                label={
                  pack.credentialKind === 'ssh'
                    ? 'Deploy key for the new workstations'
                    : 'Access token for the new workstations'
                }
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                rows={4}
                autoComplete="off"
                hint="Encrypted here for each workstation; the server never sees it."
              />
            )}
            {needsKey && <SecureContextNotice />}
            {error && <Callout tone="danger">{error}</Callout>}
            <ErrorBox error={set.error} />
          </div>
        </Dialog>
      )}
    </>
  );
}
