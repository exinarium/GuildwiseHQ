import { isHttpUrl } from '@aom/shared';

/** An `href` that is safe to render: http(s) only (`javascript:` and `data:` URLs from stored items never become links). */
export const safeHref = (url: string | null | undefined): string | undefined =>
  url && isHttpUrl(url) ? url : undefined;
