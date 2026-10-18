import { formatBytes, MAX_ATTACHMENT_BYTES } from '@aom/shared';
import { Paperclip, X } from 'lucide-react';
import { useId, useState } from 'react';
import { Button, Panel } from './ui.tsx';

/** The files picked on the New card form; they are attached as soon as the card exists. */
export function NewCardFiles({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  const id = useId();
  const [problem, setProblem] = useState('');
  const pick = (list: FileList | null) => {
    const picked = [...(list ?? [])];
    const big = picked.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
    setProblem(
      big.length
        ? `${big.map((f) => f.name).join(', ')}: larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`
        : '',
    );
    onChange([...files, ...picked.filter((f) => f.size <= MAX_ATTACHMENT_BYTES)]);
  };
  return (
    <Panel title="Attachments" data-testid="new-card-files">
      <p className="mb-2 text-sm text-muted">
        Screenshots, designs or documents the builder and tester should look at. They are attached when the
        card is saved; you can add more on the card.
      </p>
      <input
        id={id}
        type="file"
        multiple
        accept="image/*,application/*,text/*,audio/*,video/*"
        className="sr-only"
        aria-label="Add files to the new card"
        data-testid="new-card-file-input"
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = '';
        }}
      />
      <Button size="sm" onClick={() => document.getElementById(id)?.click()}>
        <Paperclip aria-hidden="true" className="size-4" />
        Add files
      </Button>
      {problem && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {problem}
        </p>
      )}
      {files.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 text-sm">
          {files.map((f, i) => (
            <li
              key={`${f.name}:${f.size}:${f.lastModified}`}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate">
                {f.name} <span className="text-subtle">{formatBytes(f.size)}</span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Do not attach ${f.name}`}
                onClick={() => onChange(files.filter((_, j) => j !== i))}
              >
                <X aria-hidden="true" className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
