import * as DM from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from './cx.ts';

/** A row/overflow menu (Radix DropdownMenu): arrow-key navigation, typeahead, focus return. */
export function Menu({
  label,
  trigger,
  children,
  align = 'end',
}: {
  label: string;
  trigger?: ReactNode;
  children: ReactNode;
  align?: 'start' | 'end';
}) {
  return (
    <DM.Root>
      <DM.Trigger
        aria-label={label}
        className={
          trigger
            ? undefined
            : 'inline-flex size-9 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-fg [@media(pointer:coarse)]:size-11'
        }
      >
        {trigger ?? <MoreHorizontal aria-hidden="true" className="size-4" />}
      </DM.Trigger>
      <DM.Portal>
        <DM.Content
          align={align}
          sideOffset={6}
          className="z-70 min-w-48 animate-fade rounded-control border border-line bg-surface p-1 shadow-md"
        >
          {children}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export function MenuItem({
  children,
  onSelect,
  danger = false,
  description,
  disabled,
}: {
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <DM.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cx(
        'flex cursor-pointer flex-col rounded-[6px] px-3 py-2 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-sunken [@media(pointer:coarse)]:py-3',
        danger ? 'text-danger' : 'text-fg',
      )}
    >
      <span className="font-medium">{children}</span>
      {description && <span className="text-xs font-normal text-subtle">{description}</span>}
    </DM.Item>
  );
}

export function MenuSeparator() {
  return <DM.Separator className="my-1 h-px bg-line" />;
}
