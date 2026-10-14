import {
  CONNECTABLE_FORGES,
  type ConnectableForge,
  detectForgeKind,
  FORGE_KINDS,
  FORGE_LABELS,
  type ForgeKind,
  type ProjectRepoDto,
} from '@aom/shared';
import { useState } from 'react';
import { useMe } from '../api/queries/auth.ts';
import { useSetRepoForge } from '../api/queries/forges.ts';
import { useWorkstations } from '../api/queries/workstations.ts';
import { ConnectHelper, ConnectionBadge, connectionOf } from './GitConnections.tsx';
import { Badge, Button, ErrorBox } from './ui.tsx';

/**
 * The git host of one repository: shown as a badge with this user's connection status and a "Connect" helper; the
 * owner can override the detected provider (a self-hosted server we cannot recognise from its URL).
 */
export function RepoProviderControl({
  projectId,
  repo,
  isOwner,
}: {
  projectId: string;
  repo: ProjectRepoDto;
  isOwner: boolean;
}) {
  const set = useSetRepoForge(projectId);
  const workstations = useWorkstations();
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState(false);
  const kind: ForgeKind = repo.forge ?? detectForgeKind(repo.remoteUrl);
  const list = workstations.data ?? [];
  const ws = list.find((w) => w.connected) ?? list[0];
  const connectable = (CONNECTABLE_FORGES as readonly string[]).includes(kind);
  const conn = connectable && ws ? connectionOf(ws, kind as ConnectableForge) : undefined;
  return (
    <div className="mt-2 text-sm" data-testid={`repo-provider-${repo.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-subtle">Git host</span>
        <Badge>{FORGE_LABELS[kind]}</Badge>
        {repo.forgeOverride && <Badge tone="blue">chosen by you</Badge>}
        {connectable && ws && <ConnectionBadge c={conn} />}
        {connectable && ws && conn?.state !== 'connected' && (
          <Button size="sm" variant="secondary" onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Connect'}
          </Button>
        )}
        {kind === 'git' && (
          <span className="text-xs text-subtle">
            Plain git: the branch is pushed, no pull request is opened.
          </span>
        )}
        {isOwner && (
          <Button size="sm" variant="ghost" onClick={() => setEdit(!edit)}>
            Change
          </Button>
        )}
      </div>
      {edit && isOwner && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            aria-label={`Git host of ${repo.name}`}
            className="h-9 rounded-control border border-control bg-surface px-2"
            value={repo.forgeOverride ?? 'auto'}
            onChange={(e) => {
              const v = e.target.value;
              set.mutate(
                { repoId: repo.id, forge: v === 'auto' ? null : (v as ForgeKind) },
                { onSuccess: () => setEdit(false) },
              );
            }}
          >
            <option value="auto">Detect from the URL</option>
            {FORGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {FORGE_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
      )}
      {connectable && ws && conn && conn.state !== 'connected' && conn.detail && (
        <p className="mt-1 text-xs text-subtle" data-testid={`repo-provider-detail-${repo.name}`}>
          {conn.detail}
        </p>
      )}
      <ErrorBox error={set.error} />
      {open && connectable && ws && (
        <ConnectHelper
          provider={kind as ConnectableForge}
          workstationId={ws.id}
          {...(conn?.host ? { host: conn.host } : {})}
          {...(me.data && ws.userId !== me.data.user.id
            ? { ownerName: (ws as { ownerEmail?: string }).ownerEmail ?? 'the workstation owner' }
            : {})}
        />
      )}
    </div>
  );
}
