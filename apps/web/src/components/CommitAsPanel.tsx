import {
  COMMIT_IDENTITY_SOURCE_LABEL,
  type CommitAsResponse,
  CommitAsSchema,
  NO_COMMIT_IDENTITY_MESSAGE,
} from '@aom/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { useCommitAs, useSaveCommitAs } from '../api/queries/commit-as.ts';
import { Button, ErrorBox, Panel, TextInput, useToast } from './ui.tsx';

type Clone = CommitAsResponse['clones'][number];

/** The identity a clone commits with, in the owner's words (the project setting wins over the clone's own). */
export function effectiveIdentityText(setting: CommitAsResponse['commitAs'], clone: Clone): string {
  if (setting)
    return `Commits are made as ${setting.name} <${setting.email}> (from ${COMMIT_IDENTITY_SOURCE_LABEL.project}).`;
  if (clone.identity)
    return `Commits are made as ${clone.identity.name} <${clone.identity.email}> (from ${COMMIT_IDENTITY_SOURCE_LABEL[clone.identity.source]}).`;
  return `Nothing can be committed here yet. ${NO_COMMIT_IDENTITY_MESSAGE}`;
}

/**
 * Project settings > Commit as (backlog #65): the name and e-mail every commit of the project carries, so the work reads
 * as the owner's own. Without it the clone's git config and then the workstation's global git config are used; with
 * none of the three, nothing is committed. Not a secret.
 */
export function CommitAsPanel({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const q = useCommitAs(projectId);
  const save = useSaveCommitAs(projectId);
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState<string | undefined>();

  const data = q.data;
  useEffect(() => {
    if (!data) return;
    setName(data.commitAs?.name ?? '');
    setEmail(data.commitAs?.email ?? '');
  }, [data]);

  if (q.isPending) return <Panel title="Commit as">Loading...</Panel>;
  if (q.isError)
    return (
      <Panel title="Commit as">
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </Panel>
    );

  const d = q.data;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(undefined);
    if (!name.trim() && !email.trim()) {
      save.mutate({ commitAs: null }, { onSuccess: () => toast.success('Commit as cleared') });
      return;
    }
    const parsed = CommitAsSchema.safeParse({ name, email });
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? 'check the name and e-mail address');
      return;
    }
    save.mutate({ commitAs: parsed.data }, { onSuccess: () => toast.success('Commit as saved') });
  };

  return (
    <Panel title="Commit as" data-testid="commit-as">
      <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Commit as">
        <p className="text-sm text-muted">
          Every commit and merge made for this project carries this name and e-mail address, so the work reads
          as yours. Leave it empty to use the repository's git config, then the workstation's global git
          config.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput
            label="Name"
            value={name}
            disabled={!canEdit}
            onChange={(e) => setName(e.target.value)}
            placeholder="Pieter Jordaan"
          />
          <TextInput
            label="E-mail"
            value={email}
            disabled={!canEdit}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="pieter@example.com"
          />
        </div>
        {problem && (
          <p role="alert" className="text-sm text-danger-fg">
            {problem}
          </p>
        )}
        {save.isError && <ErrorBox error={save.error} />}
        {canEdit ? (
          <Button type="submit" className="self-start" disabled={save.isPending}>
            Save
          </Button>
        ) : (
          <p className="text-xs text-subtle">
            Only the project Owner or an organization Owner or Admin can change this.
          </p>
        )}
      </form>
      <ul className="mt-4 flex flex-col gap-1 text-sm" data-testid="commit-identities">
        {(d.clones ?? []).length === 0 && (
          <li className="text-subtle">
            {d.commitAs
              ? `Commits are made as ${d.commitAs.name} <${d.commitAs.email}> (from ${COMMIT_IDENTITY_SOURCE_LABEL.project}).`
              : 'No workstation has a clone of this project yet.'}
          </li>
        )}
        {(d.clones ?? []).map((c) => (
          <li key={`${c.repoId}:${c.workstationId}`}>
            <span className="font-medium text-fg">
              {c.repoName} on {c.workstationName}:
            </span>{' '}
            <span className="text-muted">{effectiveIdentityText(d.commitAs, c)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
