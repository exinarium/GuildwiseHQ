import { type CommitAsResponse, CommitAsSchema } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useMe } from '../api/queries/auth.ts';
import { useCommitAs, useSaveCommitAs } from '../api/queries/commit-as.ts';
import { Button, Callout, ErrorBox, TextInput, useToast } from './ui.tsx';

/**
 * Whether a project's commits have no identity yet: no "Commit as", no app it posts as, and a workstation clone without a
 * git identity (or no clone reported yet). Without one the runner refuses every commit (`no_commit_identity`).
 */
export function commitIdentityMissing(d: CommitAsResponse | undefined): boolean {
  if (!d || d.commitAs) return false;
  if ((d.repos ?? []).some((r) => r.resolved.source === 'app')) return false;
  return d.clones.length === 0 || d.clones.some((c) => c.identity === null);
}

/**
 * uat-runner-fixes-3 finding 6: before a card of a project with repositories, ask once who its commits are made as
 * (prefilled with the account), so the first shifts do not stop on `no_commit_identity`.
 */
export function CommitAsPrompt({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const q = useCommitAs(projectId);
  const save = useSaveCommitAs(projectId);
  const me = useMe().data?.user;
  const toast = useToast();
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | undefined>();
  if (!commitIdentityMissing(q.data)) return null;
  if (!canEdit)
    return (
      <Callout tone="warning" data-testid="commit-as-prompt">
        This project has no "Commit as" yet, so its agents cannot commit. Ask the project owner to set it in
        the project settings.
      </Callout>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(undefined);
    const parsed = CommitAsSchema.safeParse({
      name: name ?? me?.displayName ?? '',
      email: email ?? me?.email ?? '',
    });
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? 'check the name and e-mail address');
      return;
    }
    save.mutate({ commitAs: parsed.data }, { onSuccess: () => toast.success('Commit as saved') });
  };
  return (
    <Callout tone="warning" data-testid="commit-as-prompt">
      <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Commit as">
        <p className="text-sm">
          Who should this project's commits be made as? Nothing can be committed until a name and e-mail
          address are set.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput
            label="Name"
            value={name ?? me?.displayName ?? ''}
            onChange={(e) => setName(e.target.value)}
          />
          <TextInput
            label="E-mail"
            type="email"
            value={email ?? me?.email ?? ''}
            onChange={(e) => setEmail(e.target.value)}
            error={problem}
          />
        </div>
        <ErrorBox error={save.error} />
        <div>
          <Button type="submit" loading={save.isPending} data-testid="commit-as-prompt-save">
            Save Commit as
          </Button>
        </div>
      </form>
    </Callout>
  );
}
