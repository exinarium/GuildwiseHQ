import * as DM from '@radix-ui/react-dropdown-menu';
import { Laptop, LogOut, Moon, Sun } from 'lucide-react';
import { Link } from 'react-router';
import { type ThemeChoice, useTheme } from '../../lib/useTheme.ts';
import { cx } from '../ui/cx.ts';
import { Avatar } from '../ui.tsx';

const THEMES: Array<{ id: ThemeChoice; label: string; icon: typeof Sun }> = [
  { id: 'system', label: 'System', icon: Laptop },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
];

/** Avatar + name; opens the account menu (theme, settings, sign out). */
export function UserMenu({
  name,
  email,
  isAdmin,
  collapsed = false,
  onSignOut,
  onNavigate,
}: {
  name: string;
  email: string;
  isAdmin: boolean;
  collapsed?: boolean;
  onSignOut: () => void;
  onNavigate?: () => void;
}) {
  const [theme, setTheme] = useTheme();
  return (
    <DM.Root>
      <DM.Trigger
        aria-label={collapsed ? `Account menu for ${name}` : undefined}
        className={cx(
          'flex w-full items-center gap-2.5 rounded-control text-left text-side-strong hover:bg-side-hover',
          collapsed ? 'h-10 justify-center' : 'min-h-11 px-2',
        )}
      >
        <Avatar name={name} size={28} />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{name}</span>
              <span className="block text-xs text-side-label">{isAdmin ? 'Administrator' : 'Manager'}</span>
            </span>
          </>
        )}
      </DM.Trigger>
      <DM.Portal>
        <DM.Content
          side={collapsed ? 'right' : 'top'}
          align="start"
          sideOffset={8}
          className="z-90 w-64 animate-fade rounded-card border border-line bg-surface p-1 shadow-lg"
        >
          <div className="px-3 py-2">
            <p className="truncate text-sm font-semibold text-fg">{name}</p>
            <p className="truncate text-xs text-subtle">{email}</p>
          </div>
          <DM.Separator className="my-1 h-px bg-line" />
          <DM.Label className="px-3 pt-1 pb-0.5 text-xs font-medium text-subtle">Theme</DM.Label>
          <DM.RadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemeChoice)}>
            {THEMES.map((t) => (
              <DM.RadioItem
                key={t.id}
                value={t.id}
                className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-[6px] px-3 text-sm text-fg outline-none select-none data-[highlighted]:bg-sunken"
              >
                <t.icon aria-hidden="true" className="size-4 text-muted" />
                <span className="flex-1">{t.label}</span>
                <DM.ItemIndicator>
                  <span className="block size-2 rounded-full bg-brand" />
                </DM.ItemIndicator>
              </DM.RadioItem>
            ))}
          </DM.RadioGroup>
          <DM.Separator className="my-1 h-px bg-line" />
          <DM.Item asChild>
            <Link
              to="/settings"
              onClick={onNavigate}
              className="flex min-h-9 items-center rounded-[6px] px-3 text-sm text-fg outline-none data-[highlighted]:bg-sunken"
            >
              Your settings
            </Link>
          </DM.Item>
          <DM.Item
            onSelect={onSignOut}
            className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-[6px] px-3 text-sm text-danger outline-none data-[highlighted]:bg-sunken"
          >
            <LogOut aria-hidden="true" className="size-4" />
            Log out
          </DM.Item>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
