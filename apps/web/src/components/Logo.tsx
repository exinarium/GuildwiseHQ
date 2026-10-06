import { BRAND } from '../brand.ts';
import { cx } from './ui/cx.ts';

/** The wordmark (variant `dark` = for dark backgrounds: white letters; `light` = ink letters; `auto` follows the theme). */
export function Logo({
  variant = 'auto',
  height = 28,
  className,
}: {
  variant?: 'dark' | 'light' | 'auto';
  height?: number;
  className?: string;
}) {
  const w = Math.round((height * 221) / 48);
  const img = (v: 'dark' | 'light', cls?: string) => (
    <img
      src={`/brand/logo-${v}.svg`}
      alt={cls ? '' : BRAND.name}
      aria-hidden={cls ? true : undefined}
      width={w}
      height={height}
      className={cx('block shrink-0', cls)}
      style={{ height, width: w }}
    />
  );
  if (variant === 'auto')
    return (
      <span role="img" aria-label={BRAND.name} className={cx('inline-flex', className)}>
        {img('light', 'dark:hidden')}
        {img('dark', 'hidden dark:block')}
      </span>
    );
  return <span className={cx('inline-flex', className)}>{img(variant)}</span>;
}

/** The square mark (the G tile). */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <img
      src="/brand/logo-mark.svg"
      alt={BRAND.name}
      width={size}
      height={size}
      className={cx('block shrink-0', className)}
      style={{ height: size, width: size }}
    />
  );
}
