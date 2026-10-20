import { matchPath } from 'react-router';
import { PAGE_HELP } from './page-help-content.ts';
import type { PageHelp } from './types.ts';

/** Routes that only redirect or are public: they have no help panel. */
export const NO_PAGE_HELP = [
  '*',
  '/',
  '/admin',
  '/p/:projectKey/feed',
  '/schedules',
  '/login',
  '/invite/:token',
  '/forgot-password',
  '/reset-password/:token',
  '/contact',
  '/signup',
  '/verify-email/:token',
  '/billing-required',
];

/** Routes that show another route's page (the Help centre's articles and glossary): they use its help. */
export const PAGE_HELP_ALIAS: Record<string, string> = {
  '/workstations/:id/integrations': '/integrations',
  '/ceo-chat/:threadId': '/ceo-chat',
  '/help/glossary': '/help',
  '/help/:slug': '/help',
  '/help/blog': '/help',
  '/help/blog/:slug': '/help',
  '/platform/help/glossary': '/platform/help',
  '/platform/help/blog': '/platform/help',
  '/platform/help/blog/:slug': '/platform/help',
  '/platform/help/:slug': '/platform/help',
};

/** The help for the page at `pathname` (the most specific route pattern wins). */
export function pageHelpFor(pathname: string): { pattern: string; help: PageHelp } | null {
  // static routes before parameterised ones (/cards/new before /cards/:ref), then the longer pattern
  const keys = [...Object.keys(PAGE_HELP), ...Object.keys(PAGE_HELP_ALIAS)].sort(
    (a, b) => a.split(':').length - b.split(':').length || b.length - a.length,
  );
  for (const k of keys) {
    const target = PAGE_HELP_ALIAS[k] ?? k;
    if (PAGE_HELP_ALIAS[k]) {
      if (matchPath({ path: k, end: true }, pathname))
        return { pattern: target, help: PAGE_HELP[target] as PageHelp };
      continue;
    }
    if (matchPath({ path: k, end: true }, pathname)) return { pattern: k, help: PAGE_HELP[k] as PageHelp };
  }
  return null;
}
