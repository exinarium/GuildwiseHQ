import { BRAND } from '../brand.ts';

/**
 * The organization this browser tab works in (docs/design/organizations.md section 5). It lives in `sessionStorage`
 * so every tab keeps its own, and travels on every request as `X-AOM-Org` and on the socket as `?org=`. The server's
 * session default only applies to a tab that has none.
 */
const KEY = `${BRAND.storagePrefix}-org`;

export function getActiveOrgId(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setActiveOrgId(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(KEY, id);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the server's default org applies */
  }
}
