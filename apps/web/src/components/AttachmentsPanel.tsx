import { type CardAttachmentDto, formatBytes, MAX_ATTACHMENT_BYTES } from '@aom/shared';
import { Download, FileText, Paperclip, Trash2 } from 'lucide-react';
import { type DragEvent, useId, useRef, useState } from 'react';
import { attachmentUrl, useRemoveAttachment, useUploadAttachments } from '../api/queries/attachments.ts';
import { Button, Callout, ConfirmDialog, Panel } from './ui.tsx';

/**
 * Files on a card (docs/USER-GUIDE.md "Attachments"): drag files in or pick them, see screenshots as previews, download
 * or remove a file. Agents add files too (the BA from a Jira ticket); builders and testers get them next to their shift.
 */
export function AttachmentsPanel({
  cardId,
  attachments,
  canAttach,
}: {
  cardId: string;
  attachments: readonly CardAttachmentDto[];
  canAttach: boolean;
}) {
  const upload = useUploadAttachments(cardId);
  const remove = useRemoveAttachment(cardId);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [over, setOver] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [removing, setRemoving] = useState<CardAttachmentDto | null>(null);

  if (attachments.length === 0 && !canAttach) return null;

  const add = (list: FileList | File[]) => {
    const files = [...list];
    if (files.length === 0) return;
    const tooBig = files.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
    const ok = files.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);
    const issues = tooBig.map((f) => `${f.name}: larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
    setProblems(issues);
    if (ok.length === 0) return;
    upload.mutate(ok, {
      onSuccess: ({ failed }) => setProblems([...issues, ...failed.map((f) => `${f.name}: ${f.message}`)]),
    });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (canAttach) add(e.dataTransfer.files);
  };

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Paperclip aria-hidden="true" className="size-4" />
          Attachments{attachments.length > 0 ? ` (${attachments.length})` : ''}
        </span>
      }
      actions={
        canAttach ? (
          <>
            <input
              ref={input}
              id={inputId}
              type="file"
              multiple
              accept="image/*,application/*,text/*,audio/*,video/*"
              className="sr-only"
              data-testid="attachment-input"
              aria-label="Add files to this card"
              onChange={(e) => {
                add(e.target.files ?? []);
                e.target.value = '';
              }}
            />
            <Button size="sm" loading={upload.isPending} onClick={() => input.current?.click()}>
              Add files
            </Button>
          </>
        ) : undefined
      }
      data-testid="attachments"
    >
      <div
        role="group"
        aria-label="Attached files; drop files here to add them"
        onDragOver={(e) => {
          if (!canAttach) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        data-testid="attachment-drop"
        className={
          over
            ? 'rounded-control border-2 border-dashed border-brand bg-sunken p-2'
            : 'rounded-control border-2 border-dashed border-transparent p-2'
        }
      >
        {problems.length > 0 && (
          <Callout tone="danger" role="alert" className="mb-3" title="Some files were not attached">
            <ul className="list-disc pl-4">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Callout>
        )}
        {attachments.length === 0 ? (
          <p className="text-sm text-subtle">
            No files yet. Drop screenshots or documents here, or choose Add files. Builders and testers see
            them next to their work.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2" data-testid="attachment-list">
            {attachments.map((a) => (
              <li key={a.id} className="flex gap-3 rounded-control border border-line p-2">
                <a
                  href={attachmentUrl(cardId, a.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-control bg-sunken"
                  aria-label={`Open ${a.name}`}
                >
                  {a.image ? (
                    <img
                      src={attachmentUrl(cardId, a.id)}
                      alt={`Preview of ${a.name}`}
                      loading="lazy"
                      className="size-full object-contain"
                    />
                  ) : (
                    <FileText aria-hidden="true" className="size-6 text-subtle" />
                  )}
                </a>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={a.name}>
                    {a.name}
                  </p>
                  <p className="text-xs text-subtle">
                    {formatBytes(a.size)} · {a.addedByName ?? 'someone'}
                    {a.addedByAgent ? ' (agent)' : ''} · {new Date(a.createdAt).toLocaleDateString()}
                    {a.source ? ` · from ${a.source}` : ''}
                  </p>
                  <div className="mt-1 flex items-center gap-1">
                    <a
                      href={attachmentUrl(cardId, a.id, true)}
                      className="inline-flex h-8 items-center gap-1 rounded-control px-2 text-sm text-brand-text hover:bg-sunken [@media(pointer:coarse)]:min-h-11"
                      aria-label={`Download ${a.name}`}
                    >
                      <Download aria-hidden="true" className="size-4" />
                      Download
                    </a>
                    {canAttach && (
                      <Button
                        size="sm"
                        variant="danger-ghost"
                        aria-label={`Remove ${a.name}`}
                        onClick={() => setRemoving(a)}
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => {
          if (!o) setRemoving(null);
        }}
        title={`Remove ${removing?.name ?? 'the file'}?`}
        description="The file is deleted from the card. Agents that already copied it keep their copy until their shift ends."
        confirmLabel="Remove file"
        pending={remove.isPending}
        onConfirm={() => {
          if (removing)
            remove.mutate(removing.id, {
              onSettled: () => setRemoving(null),
              onError: (e) =>
                setProblems([`${removing.name}: ${e instanceof Error ? e.message : 'could not remove'}`]),
            });
        }}
      />
    </Panel>
  );
}
