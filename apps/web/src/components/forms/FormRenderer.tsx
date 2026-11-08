import {
  type FormAnswerValue,
  type FormDefinition,
  type FormField,
  type FormFieldError,
  type FormFieldErrorCode,
  formatAllowedType,
  formatFormBytes,
  validateFieldAnswer,
  validateFormAnswers,
} from '@aom/shared/forms';
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';
import { Button } from '../ui/Button.tsx';
import { cx } from '../ui/cx.ts';
import { inputCls } from '../ui/inputCls.ts';

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
  initialAnswers,
  onAnswersChange,
  onFileChange,
  done: doneProp,
  busy,
  status,
  serverErrors,
  extra,
}: {
  definition: FormDefinition;
  logoUrl?: string | undefined;
  mode: 'preview' | 'public';
  /** Preview: ignored. Public: awaited; the form shows its confirmation only when `done` is set by the page. */
  onSubmit?: (answers: Answers) => void | Promise<void>;
  /** Public only: answers restored after a reload (text answers; a file cannot be restored). */
  initialAnswers?: Answers;
  /** Public only: every change of the answers (the page mirrors them to `sessionStorage`). */
  onAnswersChange?: (answers: Answers) => void;
  /** Public only: the chosen `File` of a file field, or null when it was cleared. */
  onFileChange?: (fieldId: string, file: File | null) => void;
  /** Public only: the page decides when the confirmation shows. */
  done?: boolean;
  /** Public only: disables the submit button while the page sends. */
  busy?: boolean;
  /** Public only: progress, retry and error text above the submit button. */
  status?: ReactNode;
  /** Public only: codes from the server's answer, shown with the shared wording. */
  serverErrors?: Record<string, FormFieldErrorCode>;
  /** Public only: a slot inside the form (the page puts its honeypot here). */
  extra?: ReactNode;
}) {
  const uid = useId();
  const pub = mode === 'public';
  // A `File` cannot be restored: file answers of an earlier visit are dropped and the person is asked to choose again.
  const [answers, setAnswers] = useState<Answers>(() => {
    if (!pub || !initialAnswers) return {};
    const kept: Answers = { ...initialAnswers };
    for (const f of definition.fields) if (f.type === 'file') delete kept[f.id];
    return kept;
  });
  const [errors, setErrors] = useState<Record<string, FormFieldError>>({});
  const [doneLocal, setDone] = useState(false);
  const done = pub ? (doneProp ?? false) : doneLocal;
  const summary = useRef<HTMLDivElement>(null);
  const { settings, fields } = definition;
  const fid = (f: FormField) => `${uid}-${f.id}`;

  const set = (f: FormField, v: FormAnswerValue) => {
    setAnswers((a) => {
      const next = { ...a, [f.id]: v };
      if (pub) onAnswersChange?.(next);
      return next;
    });
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

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (pub && busy) return;
    const r = validateFormAnswers(definition, answers);
    setErrors(r.errors);
    if (!r.ok) {
      setTimeout(() => summary.current?.focus(), 0);
      return;
    }
    if (pub) {
      await onSubmit?.(answers);
      return;
    }
    setDone(true);
  };

  // Codes the server refused, worded by the shared validator (the same words as the browser's own check).
  const shown: Record<string, FormFieldError> = { ...errors };
  if (pub && serverErrors)
    for (const f of definition.fields) {
      const code = serverErrors[f.id];
      if (!code || shown[f.id]) continue;
      shown[f.id] = validateFieldAnswer(f, answers[f.id]) ?? {
        code,
        message:
          code === 'malware_detected'
            ? 'This file failed a security check. Choose a different file.'
            : 'Please check this answer and try again.',
      };
    }

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
        {!pub && (
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

  const errorList = fields.filter((f) => shown[f.id]);
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
                : {shown[f.id]?.message}
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
          error={shown[f.id]}
          restored={pub && f.type === 'file' && !!initialAnswers?.[f.id] && !answers[f.id]}
          onChange={(v) => set(f, v)}
          onBlur={(v) => blur(f, v)}
          onFile={pub ? (file) => onFileChange?.(f.id, file) : undefined}
        />
      ))}
      {pub && extra}
      {pub && status}
      <div>
        <Button type="submit" variant="primary" data-testid="form-submit" disabled={pub && busy}>
          {pub && busy ? 'Sending…' : 'Submit'}
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
  restored,
  onChange,
  onBlur,
  onFile,
}: {
  field: FormField;
  id: string;
  value: FormAnswerValue;
  error: FormFieldError | undefined;
  /** A file answer restored from an earlier visit: the person must choose the file again. */
  restored?: boolean;
  onChange: (v: FormAnswerValue) => void;
  onBlur: (v?: FormAnswerValue) => void;
  onFile?: ((file: File | null) => void) | undefined;
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
      {field.type === 'file' && restored && (
        <p className="text-sm text-warning-soft-fg" data-testid={`file-again-${field.id}`}>
          Choose this file again.
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
            onFile?.(file ?? null);
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
