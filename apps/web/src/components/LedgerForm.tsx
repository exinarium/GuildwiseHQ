import type { CreateLedgerEntryRequest } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useAddLedgerEntry } from '../api/queries/ledger.ts';
import { useProjects } from '../api/queries/projects.ts';
import { Button, ErrorBox, Select, TextArea, TextInput } from './ui.tsx';

type Kind = 'standing_order' | 'feature' | 'decision';

/**
 * Adds a requirement, decision or standing order straight to the ledger (no question needed). Standing orders may
 * apply to every project; requirements and decisions belong to a project.
 */
export function LedgerForm({ defaultKind = 'standing_order' }: { defaultKind?: Kind }) {
  const projects = useProjects();
  const add = useAddLedgerEntry();
  const [kind, setKind] = useState<Kind>(defaultKind);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [err, setErr] = useState('');
  const needsProject = kind !== 'standing_order';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return setErr('A title and the text are required');
    if (needsProject && !projectId) return setErr('Choose the project this applies to');
    setErr('');
    const req: CreateLedgerEntryRequest = {
      scope: kind,
      title: title.trim(),
      body: body.trim(),
      tags: [],
      ...(projectId ? { projectId } : {}),
    };
    add.mutate(req, {
      onSuccess: () => {
        setTitle('');
        setBody('');
      },
    });
  };

  return (
    <form onSubmit={submit} aria-label="Add to ledger" className="flex flex-col gap-2" noValidate>
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
      {add.isSuccess && !add.isPending && (
        <p role="status" className="text-sm text-success">
          Added to the ledger.
        </p>
      )}
      <Button type="submit" variant="primary" disabled={add.isPending} className="self-start">
        Add to ledger
      </Button>
    </form>
  );
}
