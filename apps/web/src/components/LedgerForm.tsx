import type { CreateLedgerEntryRequest } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { useAddLedgerEntry } from '../api/queries/ledger.ts';
import { useProjects } from '../api/queries/projects.ts';
import { Button, ErrorBox, Select, TextArea, TextInput, useToast } from './ui.tsx';

type Kind = 'standing_order' | 'feature' | 'decision';

/**
 * Adds a requirement, decision or standing order straight to the ledger (no question needed). Standing orders may
 * apply to every project; requirements and decisions belong to a project.
 */
export function LedgerForm({
  defaultKind = 'standing_order',
  onDone,
}: {
  defaultKind?: Kind;
  onDone?: () => void;
}) {
  const toast = useToast();
  const projects = useProjects();
  const add = useAddLedgerEntry();
  const [kind, setKind] = useState<Kind>(defaultKind);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [err, setErr] = useState('');
  const needsProject = kind !== 'standing_order';

  const send = (merge: boolean) => {
    if (!title.trim() || !body.trim()) return setErr('A title and the text are required');
    if (needsProject && !projectId) return setErr('Choose the project this applies to');
    setErr('');
    const req: CreateLedgerEntryRequest = {
      scope: kind,
      title: title.trim(),
      body: body.trim(),
      tags: [],
      ...(projectId ? { projectId } : {}),
      ...(merge ? { onDuplicate: 'merge' as const } : {}),
    };
    add.mutate(req, {
      onSuccess: () => {
        setTitle('');
        setBody('');
        toast.success('Added to the ledger');
        onDone?.();
      },
    });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send(false);
  };
  const duplicate = add.error instanceof ApiError && add.error.code === 'duplicate_order';

  return (
    <form onSubmit={submit} aria-label="Add to ledger" className="flex flex-col gap-4" noValidate>
      <Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
        <option value="standing_order">Standing order (every agent loads it)</option>
        <option value="feature">Requirement</option>
        <option value="decision">Decision</option>
      </Select>
      <Select
        label={needsProject ? 'Project' : 'Project (blank = every project)'}
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
      >
        <option value="">{needsProject ? 'Choose a project' : 'Every project'}</option>
        {projects.data?.map((p) => (
          <option key={p.id} value={p.id}>
            {p.key} {p.name}
          </option>
        ))}
      </Select>
      <TextInput label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <TextArea label="Text" value={body} onChange={(e) => setBody(e.target.value)} error={err} />
      <ErrorBox error={add.error} />
      {duplicate && (
        <Button type="button" onClick={() => send(true)} className="self-start">
          Merge into the existing order instead
        </Button>
      )}
      {add.isSuccess && !add.isPending && !onDone && (
        <p role="status" className="text-sm text-success">
          Added to the ledger.
        </p>
      )}
      <Button type="submit" variant="primary" loading={add.isPending} className="self-start">
        Add to ledger
      </Button>
    </form>
  );
}
