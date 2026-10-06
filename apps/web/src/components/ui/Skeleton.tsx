import { cx } from './cx.ts';

const shimmer =
  'animate-shimmer bg-sunken bg-[length:200%_100%] bg-[linear-gradient(90deg,transparent,rgb(255_255_255/.45),transparent)] dark:bg-[linear-gradient(90deg,transparent,rgb(255_255_255/.06),transparent)]';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx('rounded-control', shimmer, className)} />;
}

export function SkeletonLine({ className }: { className?: string }) {
  return <Skeleton className={cx('h-3.5 rounded', className)} />;
}

/** A page-shaped placeholder: a header and a few panels. Always `role="status"` with an sr-only label. */
export function PageSkeleton({ label = 'Loading', panels = 2 }: { label?: string; panels?: number }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}...</span>
      <div aria-hidden="true">
        <div className="mb-5 space-y-2">
          <Skeleton className="h-7 w-48" />
          <SkeletonLine className="w-72" />
        </div>
        <div className="space-y-4">
          {Array.from({ length: panels }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder
            <div key={i} className="space-y-3 rounded-card border border-line bg-surface p-4">
              <SkeletonLine className="w-1/4" />
              <SkeletonLine className="w-full" />
              <SkeletonLine className="w-5/6" />
              <SkeletonLine className="w-2/3" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A list of rows. */
export function ListSkeleton({ label = 'Loading', rows = 4 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}...</span>
      <ul aria-hidden="true" className="divide-y divide-line rounded-card border border-line bg-surface">
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder
          <li key={i} className="flex items-center gap-3 p-4">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex-1 space-y-2">
              <SkeletonLine className="w-1/3" />
              <SkeletonLine className="w-2/3" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
