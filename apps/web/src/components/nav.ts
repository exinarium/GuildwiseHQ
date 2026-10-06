/** Kept for the Interests link's test id; the sidebar itself is built from shell/nav-config.ts. */
export interface NavItem {
  to: string;
  label: string;
  testId: string;
}
export const INTERESTS_NAV: NavItem = { to: '/interests', label: 'Interests', testId: 'nav-interests' };
