import {
  type FormAnswerValue,
  type FormDefinition,
  type FormField,
  type FormFieldError,
  formatAllowedType,
  formatFormBytes,
  validateFieldAnswer,
  validateFormAnswers,
} from '@aom/shared';
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';
import { cx } from '../ui/cx.ts';
import { Button, inputCls } from '../ui.tsx';

type Answers = Record<string, FormAnswerValue>;

/**
 * A form exactly as a client sees it, with no app chrome. The builder preview uses it now; the public page reuses it.
 * Validation is the shared module (`validateFieldAnswer` on blur, `validateFormAnswers` on submit), so the words are the
 * same everywhere. Labels, descriptions and options are rendered as text only. Files are never read: only name, size and
 * type are looked at.
 */
export function FormRenderer({
  definition,
  logoUrl,
  mode,
  onSubmit,
}: {
  definition: FormDefinition;
  logoUrl?: string | undefined;
  mode: 'preview' | 'public';
  onSubmit?: (answers: Answers) => void;
}) {
  const uid = useId();
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, FormFieldError>>({});
  const [done, setDone] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  const { settings, fields } = definition;
  const fid = (f: FormField) => `${uid}-${f.id}`;

  const set = (f: FormField, v: FormAnswerValue) => {
    setAnswers((a) => ({ ...a, [f.id]: v }));
    // an error shown earlier clears as soon as the answer is fixed
    if (errors[f.id] && !validateFieldAnswer(f, v)) setErrors(({ [f.id]: _gone, ...rest }) => rest);
  };
  const blur = (f: FormField, v: FormAnswerValue = answers[f.id]) => {
    const e = validateFieldAnswer(f, v);
    setErrors((cur) => {
      const { [f.id]: _old, ...rest } = cur;
      return e ? { ...rest, [f.id]: e } : rest;
    });
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const r = validateFormAnswers(definition, answers);
    setErrors(r.errors);
    if (!r.ok) {
      setTimeout(() => summary.current?.focus(), 0);
      return;
    }
    if (mode === 'public') onSubmit?.(answers);
    setDone(true);
  };

  if (done)
    return (
      <div
        data-testid="form-done"
        className="mx-auto max-w-xl rounded-card border border-line bg-surface p-6"
      >
        <Header logoUrl={logoUrl} settings={definition.settings} />
        <p className="whitespace-pre-line text-base text-fg" data-testid="form-confirmation">
          {settings.confirmationText}
        </p>
        {mode === 'preview' && (
          <p className="mt-3 text-sm text-muted">
            Preview only: nothing was sent.{' '}
            <button
              type="button"
              className="text-brand-text underline"
              onClick={() => {
                setDone(false);
                setAnswers({});
                setErrors({});
              }}
            >
              Start again
            </button>
          </p>
        )}
      </div>
    );

  const errorList = fields.filter((f) => errors[f.id]);
  return (
    <form
      noValidate
      onSubmit={submit}
      aria-label={settings.title}
      data-testid="form-renderer"
      className="mx-auto flex max-w-xl flex-col gap-5 rounded-card border border-line bg-surface p-6"
    >
      <Header logoUrl={logoUrl} settings={settings} />
      {errorList.length > 0 && (
        <div
          ref={summary}
          tabIndex={-1}
          role="alert"
          data-testid="form-error-summary"
          className="rounded-control border border-danger bg-danger-soft p-3 text-sm text-danger-soft-fg"
        >
          <p className="font-medium">
            Please fix {errorList.length === 1 ? 'this' : 'these'} before sending:
          </p>
          <ul className="mt-1 list-disc pl-5">
            {errorList.map((f) => (
              <li key={f.id}>
                <a href={`#${fid(f)}`} className="underline">
                  {f.label}
                </a>
                : {errors[f.id]?.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {fields.map((f) => (
        <FieldView
          key={f.id}
          field={f}
          id={fid(f)}
          value={answers[f.id]}
          error={errors[f.id]}
          onChange={(v) => set(f, v)}
          onBlur={(v) => blur(f, v)}
        />
      ))}
      <div>
        <Button type="submit" variant="primary" data-testid="form-submit">
          Submit
        </Button>
      </div>
    </form>
  );
}

function Header({
  logoUrl,
  settings,
}: {
  logoUrl?: string | undefined;
  settings: FormDefinition['settings'];
}) {
  return (
    <header className="mb-4 flex flex-col gap-3">
      {logoUrl && (
        <img
          src={logoUrl}
          alt={settings.logo?.alt || settings.title}
          className="max-h-20 w-auto self-start object-contain"
          data-testid="form-logo"
        />
      )}
      <h2 className="text-2xl font-semibold text-fg">{settings.title}</h2>
      {settings.description && (
        <p className="whitespace-pre-line text-base text-muted">{settings.description}</p>
      )}
    </header>
  );
}

function FieldView({
  field,
  id,
  value,
  error,
  onChange,
  onBlur,
}: {
  field: FormField;
  id: string;
  value: FormAnswerValue;
  error: FormFieldError | undefined;
  onChange: (v: FormAnswerValue) => void;
  onBlur: (v?: FormAnswerValue) => void;
}) {
  const helpId = field.helpText ? `${id}-help` : undefined;
  const fileId = field.type === 'file' ? `${id}-files` : undefined;
  const errId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, fileId, errId].filter(Boolean).join(' ') || undefined;
  const common = {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
    'aria-required': field.required || undefined,
  } as const;
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const star = field.required ? (
    <span aria-hidden="true" className="text-danger">
      {' '}
      *
    </span>
  ) : null;
  const help = (
    <>
      {field.helpText && (
        <p id={helpId} className="text-sm text-muted">
          {field.helpText}
        </p>
      )}
      {field.type === 'file' && (
        <p id={fileId} className="text-sm text-muted" data-testid={`file-help-${field.id}`}>
          Allowed: {field.allowedTypes.map(formatAllowedType).join(', ')}. Up to{' '}
          {formatFormBytes(field.maxSizeBytes)}.
        </p>
      )}
    </>
  );
  const err = error && (
    <p id={errId} role="alert" className="text-sm font-medium text-danger" data-testid={`error-${field.id}`}>
      {error.message}
    </p>
  );

  // Groups of choices sit in a fieldset with the label as legend.
  if (field.type === 'radio' || field.type === 'checkbox') {
    const selected = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    return (
      <fieldset
        className="flex flex-col gap-1.5"
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        id={id}
      >
        <legend className="text-sm font-medium text-fg">
          {field.label}
          {star}
        </legend>
        {help}
        {field.options.map((o, i) => (
          <label
            key={o}
            className="flex min-h-9 items-center gap-2 text-base text-fg [@media(pointer:coarse)]:min-h-11"
          >
            <input
              type={field.type}
              name={id}
              value={o}
              checked={selected.includes(o)}
              data-testid={`opt-${field.id}-${i}`}
              onChange={(e) => {
                if (field.type === 'radio') onChange(o);
                else onChange(e.target.checked ? [...selected, o] : selected.filter((x) => x !== o));
              }}
              onBlur={() => undefined}
            />
            {o}
          </label>
        ))}
        {err}
      </fieldset>
    );
  }

  let input: ReactNode;
  switch (field.type) {
    case 'long_text':
      input = (
        <textarea
          {...common}
          rows={4}
          className={cx(inputCls, 'resize-y')}
          placeholder={field.placeholder}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => onBlur()}
        />
      );
      break;
    case 'dropdown':
      input = (
        <select
          {...common}
          className={inputCls}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => onBlur(e.target.value)}
        >
          <option value="">{field.placeholder || 'Choose…'}</option>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
      break;
    case 'file':
      input = (
        <input
          {...common}
          type="file"
          accept={field.allowedTypes.join(',')}
          className={cx(inputCls, 'py-1.5')}
          onChange={(e) => {
            const file = e.target.files?.[0];
            const v = file ? { name: file.name, size: file.size, type: file.type } : null;
            onChange(v);
            onBlur(v);
          }}
        />
      );
      break;
    default: {
      const type =
        field.type === 'email'
          ? 'email'
          : field.type === 'phone'
            ? 'tel'
            : field.type === 'short_text'
              ? 'text'
              : field.type;
      input = (
        <input
          {...common}
          type={type}
          className={inputCls}
          placeholder={'placeholder' in field ? field.placeholder : undefined}
          value={text}
          {...(field.type === 'number'
            ? { min: field.min, max: field.max, step: 'any', inputMode: 'decimal' as const }
            : {})}
          {...(field.type === 'date' ? { min: field.min, max: field.max } : {})}
          autoComplete={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : undefined}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => onBlur()}
        />
      );
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {field.label}
        {star}
      </label>
      {input}
      {help}
      {err}
    </div>
  );
}
