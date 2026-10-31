import type { ProjectDto } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useDeleteProject } from '../api/queries/projects.ts';
import { Reword } from './Reword.tsx';
import { Button, Dialog, ErrorBox, TextInput } from './ui.tsx';

/** Permanent delete of an archived project: the owner has to type the project key to enable the button. */
export function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: ProjectDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const del = useDeleteProject();
  const [typed, setTyped] = useState('');
  const matches = typed === project.key;
  const close = (o: boolean) => {
    if (!o) setTyped('');
    onOpenChange(o);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!matches) return;
    del.mutate({ id: project.id, confirmKey: typed }, { onSuccess: () => close(false) });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={`Delete ${project.key} permanently?`}
      description="This cannot be undone."
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-3" data-testid="delete-dialog">
        <p className="text-sm">
          All cards, threads and messages, schedules, desk items, repositories, members, digests, transcripts
          and research notes of <strong>{project.name}</strong> are removed from the database. The event log
          keeps a record that the project was deleted. <Reword>{'The vault folder is never touched.'}</Reword>
        </p>
        <TextInput
          label={`Type ${project.key} to confirm`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          data-testid="delete-confirm-input"
        />
        <ErrorBox error={del.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button
            type="submit"
            variant="danger"
            disabled={!matches || del.isPending}
            data-testid="delete-confirm"
          >
            Delete permanently
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
