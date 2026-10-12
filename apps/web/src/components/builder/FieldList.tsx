import {
  addField,
  type BuilderModel,
  FIELD_TYPE_LABEL,
  removeField,
  updateField,
} from '../../lib/builder.ts';
import { Button, Select, TextInput } from '../ui.tsx';

const TYPES = Object.keys(FIELD_TYPE_LABEL) as Array<keyof typeof FIELD_TYPE_LABEL>;

/** "Information the card carries": the custom fields of the cards that run through this workflow. */
export function FieldList({
  model,
  onChange,
  readOnly,
  onAdded,
}: {
  model: BuilderModel;
  onChange: (m: BuilderModel) => void;
  readOnly?: boolean;
  /** Called with the uid of a field that was just added (the caller moves focus there). */
  onAdded?: (uid: string) => void;
}) {
  return (
    <section aria-labelledby="builder-fields-title" className="flex flex-col gap-2" data-testid="field-list">
      <div>
        <h2 id="builder-fields-title" className="text-base font-semibold">
          Information the card carries
        </h2>
        <p className="text-xs text-subtle">
          What whoever creates a card fills in, and what steps can ask for. Every card also has a title and a
          description.
        </p>
      </div>
      {model.fields.length === 0 && <p className="text-sm text-subtle">No extra information yet.</p>}
      <ul className="flex flex-col gap-3">
        {model.fields.map((f, i) => (
          <li
            key={f.uid}
            data-testid={`field-${f.uid}`}
            className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_auto_auto]"
          >
            <TextInput
              id={`field-${f.uid}-label`}
              label={`Field ${i + 1} name`}
              value={f.label}
              disabled={readOnly}
              hint={f.key ? `Saved as ${f.key}` : undefined}
              onChange={(e) => onChange(updateField(model, f.uid, { label: e.target.value }))}
            />
            <Select
              label={`Field ${i + 1} kind`}
              value={f.type}
              disabled={readOnly}
              onChange={(e) => onChange(updateField(model, f.uid, { type: e.target.value as typeof f.type }))}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {FIELD_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
            <label className="mb-2 inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={f.required}
                disabled={readOnly}
                onChange={(e) => onChange(updateField(model, f.uid, { required: e.target.checked }))}
              />
              Must be filled in
              <span className="sr-only"> (field {i + 1})</span>
            </label>
            {!readOnly && (
              <Button
                variant="ghost"
                aria-label={`Remove field ${f.label || i + 1}`}
                onClick={() => onChange(removeField(model, f.uid))}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <div>
          <Button
            onClick={() => {
              const r = addField(model);
              onChange(r.model);
              onAdded?.(r.uid);
            }}
          >
            Add information
          </Button>
        </div>
      )}
    </section>
  );
}
