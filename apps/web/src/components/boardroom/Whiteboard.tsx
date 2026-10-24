import {
  BOARD_COLUMN_LABEL,
  BOARD_COLUMNS,
  type BoardNoteDto,
  type BoardStateDto,
  type StickyColumn,
} from '@aom/shared';
import { Check, GitMerge, Pencil, Plus, ThumbsUp, Trash2, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import {
  useAddBoardNote,
  useMergeBoardNotes,
  usePatchBoardNote,
  useRemoveBoardNote,
  useVoteBoardNote,
} from '../../api/queries/boardroom.ts';
import { Button, cx, ErrorBox } from '../ui.tsx';
import { ScoreTally } from './ScoreTally.tsx';

const COLUMN_TONE: Record<StickyColumn, string> = {
  ideas: 'border-t-success-fill',
  risks: 'border-t-danger-fill',
  questions: 'border-t-info-fill',
  decisions: 'border-t-brand',
  parked: 'border-t-control',
};

function Note({
  note,
  threadId,
  selecting,
  selected,
  onToggle,
  canManage,
  readOnly,
}: {
  note: BoardNoteDto;
  canManage: boolean;
  readOnly: boolean;
  threadId: string;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const patch = usePatchBoardNote(threadId);
  const remove = useRemoveBoardNote(threadId);
  const vote = useVoteBoardNote(threadId);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const save = () => {
    if (!text.trim()) return;
    patch.mutate({ noteId: note.id, text: text.trim() }, { onSuccess: () => setEditing(false) });
  };
  return (
    <li
      draggable={canManage && !readOnly && !editing}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', note.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      data-testid="board-note"
      data-column={note.column}
      className={cx(
        'flex flex-col gap-1 rounded-control border bg-surface px-2.5 py-2 text-sm shadow-sm',
        selected ? 'border-brand ring-1 ring-brand' : 'border-line',
      )}
    >
      {editing ? (
        <div className="flex items-center gap-1.5">
          <input
            aria-label="Edit note"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') setEditing(false);
            }}
            className="min-h-9 min-w-0 flex-1 rounded-control border border-control bg-surface px-2 text-sm"
          />
          <Button size="sm" variant="primary" aria-label="Save note" onClick={save} loading={patch.isPending}>
            <Check aria-hidden="true" className="size-4" />
          </Button>
          <Button size="sm" aria-label="Cancel" onClick={() => setEditing(false)}>
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>
      ) : (
        <p className="[overflow-wrap:anywhere]">{note.text}</p>
      )}
      {note.mergedFrom.length > 0 && (
        <p className="text-xs text-subtle [overflow-wrap:anywhere]">Merged: {note.mergedFrom.join('; ')}</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-subtle">
        {selecting && (
          <input
            type="checkbox"
            aria-label="Select note to merge"
            checked={selected}
            onChange={onToggle}
            className="size-4"
          />
        )}
        <span className="min-w-0 truncate">{note.byName}</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label={note.votedByMe ? 'Take back your vote' : 'Vote +1'}
          aria-pressed={note.votedByMe}
          data-testid="vote-note"
          disabled={readOnly}
          onClick={() => vote.mutate(note.id)}
          className={cx(
            'inline-flex h-7 items-center gap-1 rounded-control px-1.5 [@media(pointer:coarse)]:h-9',
            note.votedByMe ? 'bg-brand-soft text-brand-soft-fg' : 'text-muted hover:bg-sunken hover:text-fg',
          )}
        >
          <ThumbsUp aria-hidden="true" className="size-3.5" />
          <span className="tnum">{note.votes}</span>
        </button>
        {canManage && !readOnly && (
          <>
            <label className="sr-only" htmlFor={`move-${note.id}`}>
              Move to
            </label>
            <select
              id={`move-${note.id}`}
              value={note.column}
              onChange={(e) => patch.mutate({ noteId: note.id, column: e.target.value as StickyColumn })}
              className="h-7 rounded-control border border-control bg-surface px-1 text-xs [@media(pointer:coarse)]:h-9"
            >
              {BOARD_COLUMNS.map((c) => (
                <option key={c} value={c}>
                  {BOARD_COLUMN_LABEL[c]}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label="Edit note text"
              onClick={() => setEditing(true)}
              className="inline-flex size-7 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-fg [@media(pointer:coarse)]:size-9"
            >
              <Pencil aria-hidden="true" className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="Delete note"
              onClick={() => remove.mutate(note.id)}
              className="inline-flex size-7 items-center justify-center rounded-control text-muted hover:bg-danger-soft hover:text-danger [@media(pointer:coarse)]:size-9"
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function AddNote({ threadId, column }: { threadId: string; column: StickyColumn }) {
  const add = useAddBoardNote(threadId);
  const [text, setText] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    add.mutate({ column, text: text.trim() }, { onSuccess: () => setText('') });
  };
  return (
    <form
      onSubmit={submit}
      className="flex items-center gap-1.5"
      aria-label={`Add to ${BOARD_COLUMN_LABEL[column]}`}
    >
      <input
        aria-label={`New ${BOARD_COLUMN_LABEL[column].toLowerCase()} note`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a note"
        maxLength={600}
        className="min-h-9 min-w-0 flex-1 rounded-control border border-control bg-surface px-2 text-sm"
      />
      <Button
        type="submit"
        size="sm"
        aria-label={`Add to ${BOARD_COLUMN_LABEL[column]}`}
        loading={add.isPending}
      >
        <Plus aria-hidden="true" className="size-4" />
      </Button>
    </form>
  );
}

/**
 * The whiteboard: five columns of sticky notes. Agents add notes; the owner adds, edits, moves (drag a note to another column,
 * or use its Move menu), votes +1, merges several notes into one and deletes.
 */
export function Whiteboard({
  state,
  canManage = true,
  readOnly = false,
}: {
  state: BoardStateDto;
  canManage?: boolean;
  readOnly?: boolean;
}) {
  const threadId = state.threadId;
  const patch = usePatchBoardNote(threadId);
  const merge = useMergeBoardNotes(threadId);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [over, setOver] = useState<StickyColumn | null>(null);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const doMerge = () => {
    if (picked.length < 2) return;
    merge.mutate(
      { noteIds: picked },
      {
        onSuccess: () => {
          setPicked([]);
          setSelecting(false);
        },
      },
    );
  };
  return (
    <div className="flex flex-col gap-3" data-testid="whiteboard">
      <ScoreTally scores={state.scores ?? []} />
      <div className="flex flex-wrap items-center gap-2">
        {canManage && !readOnly && (
          <Button
            size="sm"
            variant={selecting ? 'primary' : 'secondary'}
            aria-pressed={selecting}
            onClick={() => {
              setSelecting(!selecting);
              setPicked([]);
            }}
            data-testid="merge-mode"
          >
            <GitMerge aria-hidden="true" className="size-4" />
            Merge notes
          </Button>
        )}
        {selecting && (
          <Button
            size="sm"
            variant="primary"
            disabled={picked.length < 2}
            onClick={doMerge}
            loading={merge.isPending}
            data-testid="merge-selected"
          >
            Merge {picked.length} selected
          </Button>
        )}
        {state.hiddenNotes > 0 && (
          <span className="text-xs text-subtle" data-testid="hidden-notes">
            {state.hiddenNotes} note{state.hiddenNotes === 1 ? '' : 's'} sealed until the first round is
            revealed
          </span>
        )}
      </div>
      <ErrorBox error={patch.error ?? merge.error} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
        {BOARD_COLUMNS.map((c) => {
          const notes = state.notes.filter((n) => n.column === c);
          return (
            <section
              key={c}
              aria-label={BOARD_COLUMN_LABEL[c]}
              data-testid={`column-${c}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(c);
              }}
              onDragLeave={() => setOver((o) => (o === c ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const id = e.dataTransfer.getData('text/plain');
                const n = state.notes.find((x) => x.id === id);
                if (canManage && !readOnly && n && n.column !== c) patch.mutate({ noteId: id, column: c });
              }}
              className={cx(
                'flex flex-col gap-2 rounded-card border border-t-4 border-line bg-sunken p-2.5',
                COLUMN_TONE[c],
                over === c && 'ring-2 ring-brand',
              )}
            >
              <h3 className="flex items-center justify-between text-sm font-semibold text-fg">
                {BOARD_COLUMN_LABEL[c]}
                <span className="tnum text-xs font-normal text-subtle">{notes.length}</span>
              </h3>
              <ul className="flex flex-col gap-2">
                {notes.map((n) => (
                  <Note
                    key={n.id}
                    note={n}
                    threadId={threadId}
                    selecting={selecting}
                    selected={picked.includes(n.id)}
                    onToggle={() => toggle(n.id)}
                    canManage={canManage}
                    readOnly={readOnly}
                  />
                ))}
              </ul>
              {!readOnly && <AddNote threadId={threadId} column={c} />}
            </section>
          );
        })}
      </div>
    </div>
  );
}
