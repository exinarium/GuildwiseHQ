import { FIELD_TYPE_META, FORM_FIELD_TYPES, type FormField, type FormFieldType } from '@aom/shared';
import { ArrowDown, ArrowUp, Copy, GripVertical, Trash2 } from 'lucide-react';
import { type DragEvent, type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { FIELD_DRAG_TYPE } from '../../lib/formBuilder.ts';
import { cx } from '../ui/cx.ts';
import { Badge } from '../ui.tsx';
import { FIELD_ICON } from './FieldPalette.tsx';

type Control = 'up' | 'down' | 'grip';

const isFieldType = (s: string): s is FormFieldType => (FORM_FIELD_TYPES as readonly string[]).includes(s);

/**
 * The ordered list of field cards. A card is dragged by its card (HTML5 drag) or moved with its grip: focus it and press
 * the up or down arrow (Home and End go to the ends). Move up, Move down, Duplicate and Delete are buttons on every card,
 * so nothing needs a pointer or a drag. A palette type dropped between cards adds a field there. Moves are announced.
 */
export function FormCanvas({
  fields,
  selectedId,
  editable,
  onSelect,
  onMove,
  onAddAt,
  onDuplicate,
  onDelete,
  announcement,
}: {
  fields: FormField[];
  selectedId: string | null;
  editable: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, to: number, control: Control) => void;
  onAddAt: (type: FormFieldType, at: number) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  /** Spoken to screen readers ("Email moved to position 3 of 7"). */
  announcement: string;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const refocus = useRef<{ id: string; control: Control } | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const order = fields.map((f) => f.id).join(',');

  // After a move the same control keeps the focus (moving the element in the DOM would drop it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after every reorder
  useLayoutEffect(() => {
    const f = refocus.current;
    if (!f) return;
    refocus.current = null;
    const el = rows.current.get(f.id)?.querySelector<HTMLElement>(`[data-control="${f.control}"]`);
    if (el && !el.hasAttribute('disabled')) el.focus();
    else rows.current.get(f.id)?.querySelector<HTMLElement>('[data-control]:not([disabled])')?.focus();
  }, [order]);

  const move = (f: FormField, to: number, control: Control) => {
    if (to < 0 || to >= fields.length || fields[to]?.id === f.id) return;
    refocus.current = { id: f.id, control };
    onMove(f.id, to, control);
  };

  const onKey = (e: KeyboardEvent, f: FormField, i: number) => {
    if (!editable) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      move(f, i + (e.key === 'ArrowUp' ? -1 : 1), 'grip');
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      move(f, e.key === 'Home' ? 0 : fields.length - 1, 'grip');
    }
  };

  const drop = (e: DragEvent, at: number) => {
    e.preventDefault();
    const paletteType = e.dataTransfer.getData(FIELD_DRAG_TYPE);
    const id = dragId;
    setDragId(null);
    setOver(null);
    if (paletteType && isFieldType(paletteType)) {
      onAddAt(paletteType, at);
      return;
    }
    const f = fields.find((x) => x.id === id);
    // dropping on a card puts the dragged field in that card's place; the end strip means the last place
    if (f) move(f, Math.min(at, fields.length - 1), 'grip');
  };

  const allowDrop = (e: DragEvent, at: number) => {
    if (!editable) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragId ? 'move' : 'copy';
    setOver(at);
  };

  return (
    <div data-testid="form-canvas">
      <p role="status" aria-live="polite" className="sr-only" data-testid="canvas-announce">
        {announcement}
      </p>
      {fields.length === 0 ? (
        <div
          data-testid="canvas-empty"
          onDragOver={(e) => allowDrop(e, 0)}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => drop(e, 0)}
          className={cx(
            'rounded-card border-2 border-dashed border-line p-8 text-center text-sm text-muted',
            over === 0 && 'border-brand bg-brand-soft',
          )}
        >
          Drag a field here or pick one from the list.
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {fields.map((f, i) => {
            const Icon = FIELD_ICON[f.type];
            const selected = f.id === selectedId;
            const lineBefore = over === i && dragId !== f.id;
            return (
              <li
                key={f.id}
                ref={(el) => {
                  if (el) rows.current.set(f.id, el);
                  else rows.current.delete(f.id);
                }}
                data-testid={`canvas-field-${i}`}
                data-field-id={f.id}
                draggable={editable}
                onDragStart={(e) => {
                  if (!editable) return;
                  setDragId(f.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', f.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOver(null);
                }}
                onDragOver={(e) => allowDrop(e, i)}
                onDrop={(e) => drop(e, i)}
                className={cx(
                  'rounded-card border bg-surface p-3',
                  selected ? 'border-brand ring-2 ring-ring/25' : 'border-line',
                  dragId === f.id && 'opacity-50',
                  lineBefore && 'border-t-4 border-t-brand',
                )}
              >
                <div className="flex items-start gap-2">
                  {editable && (
                    <button
                      type="button"
                      data-control="grip"
                      aria-label={`Move ${f.label}. Use the up and down arrow keys.`}
                      className="inline-flex size-10 shrink-0 cursor-grab items-center justify-center rounded-control text-muted hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
                      onKeyDown={(e) => onKey(e, f, i)}
                    >
                      <GripVertical aria-hidden="true" className="size-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid={`select-field-${i}`}
                    aria-pressed={selected}
                    onClick={() => onSelect(f.id)}
                    className="flex min-h-10 min-w-0 flex-1 flex-col items-start gap-1 rounded-control text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
                  >
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                      <Icon aria-hidden="true" className="size-4 text-muted" />
                      <span className="[overflow-wrap:anywhere]">{f.label}</span>
                      {f.required && (
                        <span className="text-danger" title="Required">
                          *<span className="sr-only"> required</span>
                        </span>
                      )}
                      <Badge>{FIELD_TYPE_META[f.type].label}</Badge>
                    </span>
                    {f.helpText && <span className="text-xs text-muted">{f.helpText}</span>}
                  </button>
                  {editable && (
                    <div className="flex shrink-0 flex-wrap justify-end">
                      <IconButton
                        label={`Move ${f.label} up`}
                        control="up"
                        disabled={i === 0}
                        onClick={() => move(f, i - 1, 'up')}
                      >
                        <ArrowUp aria-hidden="true" className="size-4" />
                      </IconButton>
                      <IconButton
                        label={`Move ${f.label} down`}
                        control="down"
                        disabled={i === fields.length - 1}
                        onClick={() => move(f, i + 1, 'down')}
                      >
                        <ArrowDown aria-hidden="true" className="size-4" />
                      </IconButton>
                      <IconButton label={`Duplicate ${f.label}`} onClick={() => onDuplicate(f.id)}>
                        <Copy aria-hidden="true" className="size-4" />
                      </IconButton>
                      <IconButton label={`Delete ${f.label}`} onClick={() => onDelete(f.id)}>
                        <Trash2 aria-hidden="true" className="size-4" />
                      </IconButton>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
          <li
            aria-hidden="true"
            data-testid="canvas-end"
            onDragOver={(e) => allowDrop(e, fields.length)}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => drop(e, fields.length)}
            className={cx('h-6 rounded-control', over === fields.length && 'border-b-4 border-brand')}
          />
        </ol>
      )}
    </div>
  );
}

function IconButton({
  label,
  control,
  disabled,
  onClick,
  children,
}: {
  label: string;
  control?: Control;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      data-control={control}
      onClick={onClick}
      className="inline-flex size-10 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:text-disabled-fg disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
