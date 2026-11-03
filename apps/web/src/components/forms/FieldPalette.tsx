import { FIELD_TYPE_META, FORM_FIELD_TYPES, type FormFieldType } from '@aom/shared';
import {
  AlignLeft,
  Calendar,
  CircleDot,
  Hash,
  type LucideIcon,
  Mail,
  Phone,
  SquareCheck,
  SquareChevronDown,
  Type,
  Upload,
} from 'lucide-react';
import { FIELD_DRAG_TYPE } from '../../lib/formBuilder.ts';

export const FIELD_ICON: Record<FormFieldType, LucideIcon> = {
  short_text: Type,
  long_text: AlignLeft,
  email: Mail,
  phone: Phone,
  number: Hash,
  date: Calendar,
  dropdown: SquareChevronDown,
  radio: CircleDot,
  checkbox: SquareCheck,
  file: Upload,
};

/**
 * The ten field types. Drag one onto the canvas, or click / press Enter (tap on a touch screen) to add it after the
 * selected field.
 */
export function FieldPalette({
  onAdd,
  disabled,
}: {
  onAdd: (type: FormFieldType) => void;
  disabled?: boolean;
}) {
  return (
    <div data-testid="field-palette">
      <h2 className="mb-2 text-sm font-semibold text-fg">Fields</h2>
      <ul className="grid grid-cols-2 gap-2 xl:grid-cols-1">
        {FORM_FIELD_TYPES.map((t) => {
          const Icon = FIELD_ICON[t];
          return (
            <li key={t}>
              <button
                type="button"
                disabled={disabled}
                draggable={!disabled}
                data-testid={`palette-${t}`}
                onClick={() => onAdd(t)}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'copy';
                  e.dataTransfer.setData(FIELD_DRAG_TYPE, t);
                  e.dataTransfer.setData('text/plain', t);
                }}
                className="flex min-h-11 w-full items-center gap-2 rounded-control border border-control bg-surface px-3 py-2 text-left text-sm text-fg hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:text-disabled-fg"
              >
                <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
                {FIELD_TYPE_META[t].label}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
