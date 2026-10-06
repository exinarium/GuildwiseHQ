import { useEffect } from 'react';
import { pageTitle } from '../brand.ts';

/** Sets `document.title` to "<parts> · Guildwise HQ" while the calling page is mounted. */
export function usePageTitle(...parts: Array<string | undefined | null | false>): void {
  const title = pageTitle(...parts);
  useEffect(() => {
    document.title = title;
  }, [title]);
}
