import type { SupportContext } from '@aom/shared';
import { getClientErrors } from './client-errors.ts';

declare const __APP_VERSION__: string;

/** What Contact us attaches: where the person was, what they run, the recent errors. No query strings (they can hold tokens). */
export function buildSupportContext(opts: { includeErrors?: boolean } = {}): SupportContext {
  const errors = opts.includeErrors === false ? [] : getClientErrors();
  return {
    page: window.location.pathname,
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
    browser: navigator.userAgent,
    language: navigator.language,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(errors.length ? { errors } : {}),
  };
}
