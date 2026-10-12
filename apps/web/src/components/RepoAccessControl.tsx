import {
  type ConnectableForge,
  detectForgeKind,
  GIT_ACCESS_LABELS,
  type GitAccessMethod,
  type ProjectRepoDto,
  parseRemote,
  SSH_CHECK_LABELS,
} from '@aom/shared';
import { useState } from 'react';
import { useSetRepoAccessMethod } from '../api/queries/forges.ts';
import { useWorkstations } from '../api/queries/workstations.ts';
import { connectionOf } from './GitConnections.tsx';
import { Badge, Button, ErrorBox } from './ui.tsx';

/**
 * How the workstation reaches one repository: an API token or CLI login (https) or an SSH key. "Workstation default"
 * follows the choice made per git host in Workstations, Git hosts. The owner can override it per repository; the clone's
 * `origin` follows on every workstation that holds one.
 */
export function RepoAccessControl({
  projectId,
  repo,
  isOwner,
}: {
  projectId: string;
  repo: ProjectRepoDto;
  isOwner: boolean;
}) {
  const set = useSetRepoAccessMethod(projectId);
  const workstations = useWorkstations();
  const [edit, setEdit] = useState(false);
  const kind = repo.forge ?? detectForgeKind(repo.remoteUrl);
  const list = workstations.data ?? [];
  const ws = list.find((w) => w.connected) ?? list[0];
  const connectable =
    kind === 'github' || kind === 'gitlab' || kind === 'bitbucket-cloud' || kind === 'azure-devops';
  const conn = connectable && ws ? connectionOf(ws, kind as ConnectableForge) : undefined;
  const host = parseRemote(repo.remoteUrl, repo.forge)?.host;
  const hostDefault: GitAccessMethod = conn?.ssh?.defaultMethod ?? 'https';
  const effective: GitAccessMethod = repo.accessMethod ?? hostDefault;
  const check = conn?.ssh?.check;
  const needsToken = effective === 'ssh' && conn?.state !== 'connected';

  return (
    <div className="mt-2 text-sm" data-testid={`repo-access-${repo.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-subtle">Access</span>
        <Badge tone={effective === 'ssh' ? 'blue' : 'neutral'}>{GIT_ACCESS_LABELS[effective]}</Badge>
        {repo.accessMethod ? (
          <Badge tone="blue">chosen by you</Badge>
        ) : (
          <span className="text-xs text-subtle">workstation default{host ? ` for ${host}` : ''}</span>
        )}
        {effective === 'ssh' && check && (
          <Badge
            tone={check.state === 'ok' ? 'green' : 'amber'}
            {...(check.detail ? { title: check.detail } : {})}
          >
            {SSH_CHECK_LABELS[check.state]}
          </Badge>
        )}
        {isOwner && (
          <Button size="sm" variant="ghost" onClick={() => setEdit(!edit)}>
            {edit ? 'Cancel' : 'Change'}
          </Button>
        )}
      </div>
      {edit && isOwner && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            aria-label={`Access method of ${repo.name}`}
            className="h-9 rounded-control border border-control bg-surface px-2"
            value={repo.accessMethod ?? 'default'}
            onChange={(e) => {
              const v = e.target.value;
              set.mutate(
                { repoId: repo.id, accessMethod: v === 'default' ? null : (v as GitAccessMethod) },
                { onSuccess: () => setEdit(false) },
              );
            }}
          >
            <option value="default">Workstation default ({GIT_ACCESS_LABELS[hostDefault]})</option>
            <option value="https">{GIT_ACCESS_LABELS.https}</option>
            <option value="ssh">{GIT_ACCESS_LABELS.ssh}</option>
          </select>
        </div>
      )}
      {effective === 'ssh' && check && check.state !== 'ok' && check.detail && (
        <p className="mt-1 text-xs text-subtle" data-testid={`repo-access-detail-${repo.name}`}>
          {check.detail}
        </p>
      )}
      {effective === 'ssh' && !check && (
        <p className="mt-1 text-xs text-subtle">
          SSH is not checked yet: open Workstations, Git hosts, SSH and press Check SSH.
        </p>
      )}
      {needsToken && (
        <p className="mt-1 text-xs text-subtle" data-testid={`repo-access-rest-${repo.name}`}>
          SSH clones, fetches and pushes. Pull requests, branch rules and the repository list need the API
          token or CLI login, and this workstation has none for this host: the branch is pushed and the
          manager opens the pull request.
        </p>
      )}
      <ErrorBox error={set.error} />
    </div>
  );
}
