import { type NoteDto, PANEL_SECTION_LABEL, PANEL_SECTIONS, type PanelSection } from '@aom/shared';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useAddNote, usePatchNote, useRemoveNote } from '../../api/queries/discovery.ts';
import { Button } from '../ui.tsx';

function NoteRow({ note, threadId, canManage }: { note: NoteDto; threadId: string; canManage: boolean }) {
  const patch = usePatchNote(threadId);
  const remove = useRemoveNote(threadId);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const save = () => {
    if (!text.trim()) return;
    patch.mutate({ noteId: note.id, text: text.trim() }, { onSuccess: () => setEditing(false) });
  };
  return (
    <li
      className="group flex flex-col gap-1 rounded-control border border-line bg-surface px-2.5 py-2 text-sm"
      data-testid="panel-note"
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
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-subtle">
        <span>{note.byName}</span>
        <span className="flex-1" />
        {canManage && (
          <>
            <label className="sr-only" htmlFor={`move-${note.id}`}>
              Move to
            </label>
            <select
              id={`move-${note.id}`}
              value={note.section}
              onChange={(e) => patch.mutate({ noteId: note.id, section: e.target.value as PanelSection })}
              className="h-7 rounded-control border border-control bg-surface px-1 text-xs [@media(pointer:coarse)]:h-9"
            >
              {PANEL_SECTIONS.map((s) => (
                <option key={s} value={s}>
                  {PANEL_SECTION_LABEL[s]}
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

function AddNote({ threadId, section }: { threadId: string; section: PanelSection }) {
  const add = useAddNote(threadId);
  const [text, setText] = useState('');
  return (
    <form
      className="flex gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) add.mutate({ section, text: text.trim() }, { onSuccess: () => setText('') });
      }}
    >
      <input
        aria-label={`Add to ${PANEL_SECTION_LABEL[section]}`}
        placeholder="Add…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="min-h-9 min-w-0 flex-1 rounded-control border border-control bg-surface px-2 text-sm placeholder:text-subtle"
      />
      <Button type="submit" size="sm" disabled={!text.trim()} loading={add.isPending}>
        Add
      </Button>
    </form>
  );
}

/** Ideas, assumptions, open questions, decisions and parked items: kept by the facilitator, editable by the owner. */
export function PanelNotes({
  threadId,
  notes,
  canManage = true,
  readOnly = false,
}: {
  threadId: string;
  notes: NoteDto[];
  canManage?: boolean;
  readOnly?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="session-panel">
      {PANEL_SECTIONS.map((s) => {
        const list = notes.filter((n) => n.section === s);
        return (
          <section
            key={s}
            aria-label={PANEL_SECTION_LABEL[s]}
            data-testid={`panel-${s}`}
            className="flex flex-col gap-1.5"
          >
            <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
              {PANEL_SECTION_LABEL[s]}
              <span className="tnum rounded-full bg-sunken px-1.5 text-xs font-normal text-muted">
                {list.length}
              </span>
            </h3>
            {list.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {list.map((n) => (
                  <NoteRow key={n.id} note={n} threadId={threadId} canManage={canManage && !readOnly} />
                ))}
              </ul>
            )}
            {!readOnly && <AddNote threadId={threadId} section={s} />}
          </section>
        );
      })}
    </div>
  );
}
