/**
 * The navigation as data. The planned side-menu redesign renders these groups; until it lands `Layout.tsx` shows the
 * flat top bar and only adds the Interests link next to Schedules (docs/design/interests.md section 8.1).
 */
export interface NavItem {
  to: string;
  label: string;
  testId: string;
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Knowledge',
    items: [
      { to: '/interests', label: 'Interests', testId: 'nav-interests' },
      { to: '/ledger', label: 'Ledger', testId: 'nav-ledger' },
      { to: '/settings/vaults', label: 'Vaults', testId: 'nav-vaults' },
    ],
  },
];

export const INTERESTS_NAV: NavItem = NAV_GROUPS[0]?.items[0] as NavItem;
