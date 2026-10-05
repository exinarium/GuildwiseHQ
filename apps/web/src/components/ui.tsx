import * as RadixDialog from '@radix-ui/react-dialog';
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from 'react';
import { hueFor, initials } from '../lib/avatar.ts';

const cx = (...c: Array<string | false | undefined | null>) => c.filter(Boolean).join(' ');

// ---------------------------------------------------------------- buttons

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const variants: Record<Variant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-zinc-400 dark:disabled:bg-zinc-700',
  secondary:
    'border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800',
  danger: 'bg-red-600 text-white hover:bg-red-500 disabled:bg-zinc-400 dark:disabled:bg-zinc-700',
  ghost: 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
};

export function Button({
  variant = 'secondary',
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60',
        variants[variant],
        className,
      )}
      {...rest}
    />
  );
}

// ----------------------------------------------------------------- inputs

const inputCls =
  'w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-zinc-400 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900';

export function Field({
  label,
  error,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  error?: string | undefined;
  hint?: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-zinc-500">{hint}</p>}
      {error && (
        <p
          role="alert"
          id={`${htmlFor}-error`}
          className="text-xs font-medium text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </div>
  );
}

export function TextInput({
  label,
  error,
  hint,
  id,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | undefined; hint?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} error={error} hint={hint} htmlFor={fid}>
      <input
        id={fid}
        className={inputCls}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fid}-error` : undefined}
        {...rest}
      />
    </Field>
  );
}

export function TextArea({
  label,
  error,
  hint,
  id,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  error?: string | undefined;
  hint?: string;
}) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} error={error} hint={hint} htmlFor={fid}>
      <textarea
        id={fid}
        rows={3}
        className={cx(inputCls, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fid}-error` : undefined}
        {...rest}
      />
    </Field>
  );
}

export function Select({
  label,
  error,
  hint,
  id,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string | undefined; hint?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} error={error} hint={hint} htmlFor={fid}>
      <select
        id={fid}
        className={inputCls}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fid}-error` : undefined}
        {...rest}
      >
        {children}
      </select>
    </Field>
  );
}

// ---------------------------------------------------------------- display

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'red' | 'amber' | 'green' | 'blue' | 'violet';
  title?: string;
}) {
  const tones = {
    neutral: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
    red: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
    amber: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
    green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    blue: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
    violet: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  };
  return (
    <span
      title={title}
      className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium', tones[tone])}
    >
      {children}
    </span>
  );
}

export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  const hue = hueFor(name);
  return (
    <span
      role="img"
      aria-label={`Avatar for ${name}`}
      title={name}
      data-testid="avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        backgroundColor: `hsl(${hue} 55% 38%)`,
      }}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none"
    >
      {initials(name)}
    </span>
  );
}

export function ConnectionDot({ connected, label }: { connected: boolean; label?: string }) {
  const text = label ?? (connected ? 'Connected' : 'Offline');
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs"
      data-testid="connection-dot"
      data-connected={connected}
    >
      <span
        aria-hidden="true"
        className={cx('size-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-zinc-400 dark:bg-zinc-600')}
      />
      <span>{text}</span>
    </span>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <p role="status" className="p-4 text-sm text-zinc-500">
      {label}...
    </p>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <p
      role="alert"
      className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
    >
      {msg}
    </p>
  );
}

export function PageHeader({ title, actions, sub }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
        {sub && <div className="text-sm text-zinc-500">{sub}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({
  children,
  className,
  'data-testid': testId,
}: {
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={cx(
        'rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900',
        className,
      )}
    >
      {children}
    </section>
  );
}

// ----------------------------------------------------------------- dialog

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <RadixDialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          <RadixDialog.Title className="text-base font-semibold">{title}</RadixDialog.Title>
          <RadixDialog.Description className={description ? 'mt-1 text-sm text-zinc-500' : 'sr-only'}>
            {description ?? title}
          </RadixDialog.Description>
          <div className="mt-3">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
