import * as RadixDialog from '@radix-ui/react-dialog';
import { AlertCircle, ArrowLeft, Loader2, X } from 'lucide-react';
import { type ComponentProps, type ReactNode, useId } from 'react';
import { Link } from 'react-router';
import { hueFor, initials } from '../lib/avatar.ts';
import { useDelayedFlag } from '../lib/useDelayedFlag.ts';
import { useOrgTerms } from '../lib/terms.ts';
import { usePageTitle } from '../lib/usePageTitle.ts';
import { cx } from './ui/cx.ts';

export { BottomSheet } from './ui/BottomSheet.tsx';
export { Callout } from './ui/Callout.tsx';
export { FilterChip, PriorityPicker, Segmented } from './ui/Chips.tsx';
export { ConfirmDialog } from './ui/ConfirmDialog.tsx';
export { Disclosure } from './ui/Disclosure.tsx';
export { EmptyState } from './ui/EmptyState.tsx';
export { Menu, MenuItem, MenuSeparator } from './ui/Menu.tsx';
export { ListSkeleton, PageSkeleton, Skeleton, SkeletonLine } from './ui/Skeleton.tsx';
export { StatusDot } from './ui/StatusDot.tsx';
export { type Step, Stepper } from './ui/Stepper.tsx';
export { Tabs } from './ui/Tabs.tsx';
export { ToastProvider, useToast } from './ui/Toast.tsx';
export { cx };

// ---------------------------------------------------------------- buttons

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'danger-ghost' | 'link';
type Size = 'sm' | 'md' | 'lg';
const variants: Record<Variant, string> = {
  primary: 'bg-brand text-brand-fg hover:bg-brand-hover disabled:bg-sunken disabled:text-disabled-fg',
  secondary:
    'border border-control bg-surface text-fg hover:bg-sunken disabled:text-disabled-fg disabled:hover:bg-surface',
  danger:
    'bg-danger-fill text-white hover:brightness-95 disabled:opacity-50 dark:border dark:border-danger-fill/60 dark:bg-danger-soft dark:text-danger-soft-fg dark:hover:brightness-110',
  ghost: 'text-muted hover:bg-sunken hover:text-fg disabled:text-disabled-fg disabled:hover:bg-transparent',
  'danger-ghost': 'text-danger hover:bg-danger-soft disabled:text-disabled-fg disabled:hover:bg-transparent',
  link: 'text-brand-text underline-offset-2 hover:underline disabled:text-disabled-fg',
};
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm [@media(pointer:coarse)]:min-h-11',
  md: 'h-9 px-3.5 text-sm [@media(pointer:coarse)]:min-h-11',
  lg: 'h-11 px-5 text-base',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  className,
  type = 'button',
  disabled,
  children,
  ...rest
}: ComponentProps<'button'> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap transition-colors duration-100 active:translate-y-px disabled:cursor-not-allowed',
        variant !== 'link' && sizes[size],
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

/** A button-shaped router link, for navigation that should look like an action. */
export function ButtonLink({
  to,
  variant = 'secondary',
  size = 'md',
  className,
  children,
  ...rest
}: { to: string; variant?: Variant; size?: Size; className?: string; children: ReactNode } & Omit<
  React.ComponentProps<typeof Link>,
  'to' | 'className'
>) {
  return (
    <Link
      to={to}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap transition-colors duration-100',
        variant !== 'link' && sizes[size],
        variants[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </Link>
  );
}

// ----------------------------------------------------------------- inputs

export const inputCls =
  'w-full min-h-9 rounded-control border border-control bg-surface px-3 py-1.5 text-base text-fg placeholder:text-subtle focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:bg-sunken disabled:text-disabled-fg [@media(pointer:coarse)]:min-h-11 aria-[invalid=true]:border-danger';

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
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-subtle">{hint}</p>}
      {error && (
        <p
          role="alert"
          id={`${htmlFor}-error`}
          className="flex items-start gap-1.5 text-sm font-medium text-danger"
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
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
  className,
  ...rest
}: ComponentProps<'input'> & { label: string; error?: string | undefined; hint?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} error={error} hint={hint} htmlFor={fid}>
      <input
        id={fid}
        className={cx(inputCls, className)}
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
}: ComponentProps<'textarea'> & {
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
        className={cx(inputCls, 'resize-y', className)}
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
  className,
  ...rest
}: ComponentProps<'select'> & { label: string; error?: string | undefined; hint?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} error={error} hint={hint} htmlFor={fid}>
      <select
        id={fid}
        className={cx(inputCls, className)}
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

type Tone =
  | 'neutral'
  | 'brand'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'red'
  | 'amber'
  | 'green'
  | 'blue'
  | 'violet';
const toneAlias: Record<Tone, 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info'> = {
  neutral: 'neutral',
  brand: 'brand',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
  red: 'danger',
  amber: 'warning',
  green: 'success',
  blue: 'info',
  violet: 'brand',
};
const toneCls = {
  neutral: 'bg-neutral-soft text-neutral-soft-fg',
  brand: 'bg-brand-soft text-brand-soft-fg',
  success: 'bg-success-soft text-success-soft-fg',
  warning: 'bg-warning-soft text-warning-soft-fg',
  danger: 'bg-danger-soft text-danger-soft-fg',
  info: 'bg-info-soft text-info-soft-fg',
};

export function Badge({
  children,
  tone = 'neutral',
  title,
  icon,
  className,
  'data-testid': testId,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
  icon?: ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <span
      title={title}
      data-testid={testId}
      className={cx(
        'inline-flex min-h-5 items-center gap-1 rounded-full px-2 py-px text-xs font-medium whitespace-nowrap [&>svg]:size-3',
        toneCls[toneAlias[tone]],
        className,
      )}
    >
      {icon}
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
        fontSize: Math.max(10, Math.round(size * 0.42)),
        backgroundColor: `hsl(${hue} 50% 30%)`,
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
      className="inline-flex items-center gap-1.5 text-xs text-muted"
      data-testid="connection-dot"
      data-connected={connected}
    >
      <span
        aria-hidden="true"
        className={cx('size-2 rounded-full', connected ? 'bg-success-fill' : 'bg-subtle/60')}
      />
      <span>{text}</span>
    </span>
  );
}

/**
 * A loading placeholder. Always announces `label...` to assistive tech; the visible skeleton only appears after
 * 150 ms so fast responses never flash. `inline` is the tiny variant for buttons and rows.
 */
export function Spinner({ label = 'Loading', inline = false }: { label?: string; inline?: boolean }) {
  const show = useDelayedFlag(true, 150);
  if (inline)
    return (
      <span role="status" className="inline-flex items-center gap-2 text-sm text-subtle">
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        {label}...
      </span>
    );
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}...</span>
      {show && (
        <div aria-hidden="true" className="space-y-3 py-2">
          <div className="h-4 w-1/3 animate-shimmer rounded bg-sunken bg-[length:200%_100%] bg-[linear-gradient(90deg,transparent,rgb(255_255_255/.45),transparent)] dark:bg-[linear-gradient(90deg,transparent,rgb(255_255_255/.06),transparent)]" />
          <div className="h-20 animate-shimmer rounded-card bg-sunken bg-[length:200%_100%] bg-[linear-gradient(90deg,transparent,rgb(255_255_255/.45),transparent)] dark:bg-[linear-gradient(90deg,transparent,rgb(255_255_255/.06),transparent)]" />
          <div className="h-20 animate-shimmer rounded-card bg-sunken bg-[length:200%_100%] bg-[linear-gradient(90deg,transparent,rgb(255_255_255/.45),transparent)] dark:bg-[linear-gradient(90deg,transparent,rgb(255_255_255/.06),transparent)]" />
        </div>
      )}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const { reword } = useOrgTerms();
  const msg = reword(error instanceof Error ? error.message : String(error));
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-control border border-danger-fill/40 bg-danger-soft p-3 text-sm text-danger-soft-fg"
    >
      <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1 break-words">{msg}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function PageHeader({
  title,
  actions,
  sub,
  back,
  eyebrow,
  documentTitle,
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  /** A link to the parent screen, shown above the title (mobile has no breadcrumbs). */
  back?: { to: string; label: string };
  eyebrow?: ReactNode;
  /** Overrides the browser tab title (default: the page title). */
  documentTitle?: string;
}) {
  usePageTitle(documentTitle ?? title);
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-[min(100%,15rem)] flex-1">
        {back && (
          <Link
            to={back.to}
            className="mb-1.5 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
            aria-label={back.label}
          >
            <ArrowLeft aria-hidden="true" className="size-3.5" />
            <span>{back.label}</span>
          </Link>
        )}
        {eyebrow}
        <h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere] text-fg">{title}</h1>
        {sub && <div className="mt-0.5 text-base text-muted">{sub}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({
  children,
  className,
  title,
  actions,
  padding = 'default',
  'data-testid': testId,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  actions?: ReactNode;
  padding?: 'none' | 'compact' | 'default';
  'data-testid'?: string;
}) {
  const pad = padding === 'none' ? '' : padding === 'compact' ? 'p-3' : 'p-4';
  return (
    <section
      data-testid={testId}
      className={cx('rounded-card border border-line bg-surface', title ? '' : pad, className)}
    >
      {title && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-lg font-semibold text-fg">{title}</h2>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {title ? <div className={pad || undefined}>{children}</div> : children}
    </section>
  );
}

// ----------------------------------------------------------------- dialog

const dialogWidth = {
  md: 'sm:w-[min(92vw,32rem)]',
  lg: 'sm:w-[min(92vw,40rem)]',
  xl: 'sm:w-[min(92vw,56rem)]',
};

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg' | 'xl';
  dismissible?: boolean;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-60 animate-fade bg-overlay" />
        <RadixDialog.Content
          onInteractOutside={dismissible ? undefined : (e) => e.preventDefault()}
          onEscapeKeyDown={dismissible ? undefined : (e) => e.preventDefault()}
          className={cx(
            'fixed z-70 flex max-h-[92dvh] flex-col overflow-hidden border border-line bg-surface shadow-lg',
            'max-sm:inset-x-0 max-sm:bottom-0 max-sm:animate-sheet max-sm:rounded-t-dialog max-sm:pb-[env(safe-area-inset-bottom)]',
            'sm:top-1/2 sm:left-1/2 sm:max-h-[90dvh] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:animate-rise sm:rounded-dialog',
            dialogWidth[size],
          )}
        >
          <div className="flex items-start gap-3 px-5 pt-4 pb-1">
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="text-lg font-semibold text-fg">{title}</RadixDialog.Title>
              <RadixDialog.Description className={description ? 'mt-1 text-base text-muted' : 'sr-only'}>
                {description ?? title}
              </RadixDialog.Description>
            </div>
            {dismissible && (
              <RadixDialog.Close
                aria-label="Close dialog"
                className="-mt-1 -mr-2 inline-flex size-10 shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-fg"
              >
                <X aria-hidden="true" className="size-4" />
              </RadixDialog.Close>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">{children}</div>
          {footer && (
            <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-3 sm:flex-row sm:justify-end [&>button]:max-sm:w-full">
              {footer}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
