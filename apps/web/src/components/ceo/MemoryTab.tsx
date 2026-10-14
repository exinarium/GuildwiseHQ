import type { CeoMemoryDtoApi } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import {
  useAddCeoMemory,
  useCeoMemories,
  useConfirmCeoMemory,
  useForgetCeoMemory,
  usePatchCeoMemory,
  useRetireCeoMemory,
} from '../../api/queries/ceo.ts';
import { MEMORY_KIND_LABEL, memorySourceLabel, pct } from '../../lib/ceo.ts';
import { formatDate } from '../../lib/time.ts';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  ErrorBox,
  Panel,
  Spinner,
  TextArea,
  useToast,
} from '../ui.tsx';

function EditDialog({ memory, onClose }: { memory: CeoMemoryDtoApi | null; onClose: () => void }) {
  const patch = usePatchCeoMemory();
  const [text, setText] = useState(memory?.text ?? '');
  // The dialog is mounted per memory (key), so the initial state is the memory's text.
  if (!memory) return null;
  const candidate = memory.status === 'candidate';
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Edit this rule"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={patch.isPending}
            disabled={!text.trim()}
            onClick={() =>
              patch.mutate(
                { id: memory.id, text: text.trim(), ...(candidate ? { confirm: true } : {}) },
                { onSuccess: onClose },
              )
            }
          >
            {candidate ? 'Save and keep' : 'Save'}
          </Button>
        </>
      }
    >
      <TextArea
        label="Rule"
        rows={4}
        maxLength={1000}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <ErrorBox error={patch.error} />
    </Dialog>
  );
}

function Meta({ m }: { m: CeoMemoryDtoApi }) {
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
      <span>{memorySourceLabel(m.source)}</span>
      <span className="tnum">confidence {pct(m.confidence)}</span>
      <span>{m.lastConfirmedAt ? `last confirmed ${formatDate(m.lastConfirmedAt)}` : 'never confirmed'}</span>
      <Badge tone={m.status === 'active' ? 'green' : m.status === 'candidate' ? 'amber' : 'neutral'}>
        {m.status === 'candidate' ? 'proposed' : m.status}
      </Badge>
    </p>
  );
}

/** What the CEO remembers about how you work. The Owner's alone: Admins only see that memories exist. */
export function MemoryTab({ owner }: { owner: boolean }) {
  const q = useCeoMemories();
  const confirm = useConfirmCeoMemory();
  const retire = useRetireCeoMemory();
  const forget = useForgetCeoMemory();
  const add = useAddCeoMemory();
  const toast = useToast();
  const [editing, setEditing] = useState<CeoMemoryDtoApi | null>(null);
  const [forgetting, setForgetting] = useState<CeoMemoryDtoApi | null>(null);
  const [text, setText] = useState('');

  if (q.isPending) return <Spinner label="Loading the memory" />;
  if (!q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const all = q.data.memories;
  if (!owner || !q.data.canView)
    return (
      <Panel>
        <p className="text-base text-muted" data-testid="ceo-memory-hidden">
          {all.length} {all.length === 1 ? 'memory exists' : 'memories exist'}; only the Owner can read them.
        </p>
      </Panel>
    );

  const candidates = all.filter((m) => m.status === 'candidate');
  const active = all.filter((m) => m.status === 'active');
  const retired = all.filter((m) => m.status === 'retired');
  const kinds = [...new Set(active.map((m) => m.kind))];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    add.mutate(
      { text: text.trim(), scope: 'org' },
      {
        onSuccess: () => {
          setText('');
          toast.success('Remembered');
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-4" data-testid="ceo-memory">
      <ErrorBox error={confirm.error ?? retire.error ?? forget.error} />
      {candidates.length > 0 && (
        <Panel title="Proposed, waiting for you" data-testid="ceo-memory-candidates">
          <ul className="divide-y divide-line">
            {candidates.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-start justify-between gap-3 py-3"
                data-testid="ceo-memory-candidate"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-base text-fg">{m.text}</p>
                  <Meta m={m} />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => confirm.mutate(m.id)}>
                    Keep
                  </Button>
                  <Button size="sm" onClick={() => setEditing(m)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => retire.mutate(m.id)}>
                    Drop
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Add a rule">
        <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Add a rule">
          <TextArea
            label="Something the CEO should always do or know"
            rows={2}
            maxLength={1000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            hint='For example: "Never touch the billing project without asking me."'
          />
          <ErrorBox error={add.error} />
          <div>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!text.trim()}>
              Remember this
            </Button>
          </div>
        </form>
      </Panel>

      {active.length === 0 && candidates.length === 0 && (
        <p className="text-sm text-muted">
          Nothing remembered yet. Answers you mark "Remember this for the CEO" and rules you add here show up
          here.
        </p>
      )}
      {kinds.map((kind) => (
        <Panel key={kind} title={MEMORY_KIND_LABEL[kind] ?? kind}>
          <ul className="divide-y divide-line">
            {active
              .filter((m) => m.kind === kind)
              .map((m) => (
                <li
                  key={m.id}
                  className="flex flex-wrap items-start justify-between gap-3 py-3"
                  data-testid="ceo-memory-row"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-base text-fg">{m.text}</p>
                    <Meta m={m} />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setEditing(m)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => retire.mutate(m.id)}>
                      Retire
                    </Button>
                    <Button size="sm" variant="danger-ghost" onClick={() => setForgetting(m)}>
                      Forget
                    </Button>
                  </div>
                </li>
              ))}
          </ul>
        </Panel>
      ))}

      {retired.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-muted hover:text-fg">
            Retired ({retired.length})
          </summary>
          <ul className="mt-2 divide-y divide-line rounded-card border border-line bg-surface px-4">
            {retired.map((m) => (
              <li key={m.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-muted">{m.text}</p>
                  <Meta m={m} />
                </div>
                <Button size="sm" variant="danger-ghost" onClick={() => setForgetting(m)}>
                  Forget
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <EditDialog key={editing?.id ?? 'none'} memory={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={forgetting !== null}
        onOpenChange={(o) => !o && setForgetting(null)}
        title="Forget this for good?"
        description="The memory is deleted, not just retired. The CEO will not remember it, and it cannot come back."
        confirmLabel="Forget"
        pending={forget.isPending}
        onConfirm={() => forgetting && forget.mutate(forgetting.id, { onSuccess: () => setForgetting(null) })}
      >
        {forgetting && <p className="rounded-control bg-sunken p-2 text-sm text-fg">{forgetting.text}</p>}
      </ConfirmDialog>
    </div>
  );
}
