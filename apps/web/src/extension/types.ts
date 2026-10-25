import type { ActiveOrg } from '@aom/shared';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import type { RouteObject } from 'react-router';
import type { PageHelp } from '../help/types.ts';

/**
 * Web extension points. The open-source web app is complete on its own: no billing, no sign-up, no support desk, every
 * organization unlimited. A hosting business adds what it needs through ONE module that default-exports a
 * `WebExtension`; the build picks it up from the `AOM_WEB_EXTENSION` environment variable (see vite.config.ts) and the
 * core imports nothing from it by name (scripts/check-no-cloud-imports.sh enforces it). Every field is optional and
 * defaults to nothing.
 */

export interface PlatformNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Show the item after this platform nav item (by its `to`); default: at the end. */
  after?: string;
  /** A small badge next to the label (renders its own query). */
  Badge?: ComponentType;
}

export interface OrgSettingsTabDef {
  id: string;
  label: string;
  /** Who sees the tab; default: the Owner and Admins. */
  roles?: Array<'owner' | 'admin' | 'member'>;
  Component: ComponentType;
}

export interface HelpTabDef {
  /** The tab id; its pages live under `/help/<id>` (the extension adds the routes). */
  id: string;
  label: string;
  testId?: string;
  /** A badge next to the label (renders its own query). */
  Badge?: ComponentType;
  Component: ComponentType;
}

export interface LoginSlotProps {
  /** The sign-in error, if any (an `ApiError`). */
  error: unknown;
  /** What the person typed in the email field. */
  email: string;
}

export interface GateProps {
  gate: NonNullable<ActiveOrg['gate']>;
  orgName: string;
}

export interface WebExtension {
  /** Public routes (no sign-in needed): sign-up, email verification, a public contact form. */
  publicRoutes?: RouteObject[];
  /** Routes inside the signed-in work shell. */
  appRoutes?: RouteObject[];
  /** Routes inside the platform administrator's shell. */
  platformRoutes?: RouteObject[];
  /** Entries of the platform navigation. */
  platformNav?: PlatformNavItem[];
  /** Extra tabs on the organization settings page. */
  orgSettingsTabs?: OrgSettingsTabDef[];
  /** Extra tabs on the help page (contact us, my requests). */
  helpTabs?: HelpTabDef[];
  /** Wraps the signed-in app (and the gate screen): providers for the extension's own dialogs and state. */
  AppProviders?: ComponentType<{ children?: ReactNode }>;
  /** The full-page screen an Owner sees instead of the app when the server reports a `gate` (billing). */
  Gate?: ComponentType<GateProps>;
  /** The path the gate screen lives at (the router redirects every other address to it while gated). */
  gatePath?: string;
  /** Extra content in the sign-in error box (resend the verification mail). */
  LoginErrorExtra?: ComponentType<LoginSlotProps>;
  /** Extra content under the sign-in form (the sign-up link, the terms line). */
  LoginFooter?: ComponentType;
  /** Panels on a platform organization's page (its subscription). */
  PlatformOrgPanels?: ComponentType<{ orgId: string }>;
  /** A banner under the platform header (payments not configured). */
  PlatformBanner?: ComponentType;
  /** The blog writer panel on the platform blog page. */
  PlatformBlogWriter?: ComponentType;
  /** True when the extension enforces plan limits and licence dates: the platform page then shows those fields. */
  planLimits?: boolean;
  /** Page help (the "what is on this page" panel) for the routes the extension adds. */
  pageHelp?: Record<string, PageHelp>;
  /** Routes of the extension without a help panel (public pages, redirects). */
  noPageHelp?: string[];
  /** Extra items in the account menu ("Contact us", "My requests"). */
  UserMenuItems?: ComponentType<{ onNavigate?: () => void }>;
}
