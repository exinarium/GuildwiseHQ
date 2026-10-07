import * as RadixDialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import {
  CornerDownLeft,
  FileText,
  FolderKanban,
  GraduationCap,
  HelpCircle,
  Inbox,
  Keyboard,
  LifeBuoy,
  type LucideIcon,
  MessageCircleQuestion,
  MessageSquare,
  Moon,
  PlusCircle,
  Search,
  Sun,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAgents } from '../../api/queries/agents.ts';
import { useDesk } from '../../api/queries/desk.ts';
import { useCardSearch } from '../../api/queries/search.ts';
import { useTheme } from '../../lib/useTheme.ts';
import { AgentAvatar } from '../Face.tsx';
import type { NavSection } from '../shell/nav-config.ts';
import { useTour } from '../tour/TourContext.tsx';
import { cx } from '../ui/cx.ts';

export interface PaletteContext {
  sections: NavSection[];
  footer: NavSection['items'];
  projects: Array<{ id: string; key: string; name: string }>;
  projectKey: string | null;
  onChat: () => void;
  onHelp: () => void;
  onContact?: () => void;
  onPageHelp?: () => void;
}

function Item({
  value,
  keywords,
  icon: Icon,
  hint,
  children,
  onSelect,
  leading,
}: {
  value: string;
  keywords?: string[];
  icon?: LucideIcon;
  hint?: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  leading?: ReactNode;
}) {
  return (
    <Command.Item
      value={value}
      {...(keywords ? { keywords } : {})}
      onSelect={onSelect}
      className="flex min-h-10 cursor-pointer items-center gap-3 rounded-control px-3 text-sm text-fg select-none data-[selected=true]:bg-brand-soft data-[selected=true]:text-brand-soft-fg [@media(pointer:coarse)]:min-h-12"
    >
      {leading ?? (Icon && <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />)}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 truncate text-xs text-subtle">{hint}</span>}
    </Command.Item>
  );
}

const GroupHeading = ({ children }: { children: ReactNode }) => (
  <span className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-subtle uppercase">{children}</span>
);

/** The body is mounted only while the palette is open, so the lists load on demand. */
function PaletteBody({ ctx, close }: { ctx: PaletteContext; close: () => void }) {
  const nav = useNavigate();
  const tour = useTour();
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useTheme();
  const agents = useAgents();
  const desk = useDesk();
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 180);
    return () => clearTimeout(t);
  }, [query]);
  const cards = useCardSearch(debounced);

  const go = (to: string) => () => {
    close();
    nav(to);
  };
  const run = (fn: () => void) => () => {
    close();
    // after the dialog has released focus
    setTimeout(fn, 0);
  };
  const dark = document.documentElement.dataset.theme === 'dark';

  return (
    <Command
      label="Command palette"
      loop
      className="flex max-h-[min(30rem,70dvh)] flex-col"
      filter={(value, search, keywords) => {
        const hay = `${value} ${(keywords ?? []).join(' ')}`.toLowerCase();
        const words = search.toLowerCase().split(/\s+/).filter(Boolean);
        return words.every((w) => hay.includes(w)) ? 1 : 0;
      }}
    >
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Search aria-hidden="true" className="size-4 shrink-0 text-subtle" />
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="Search pages, cards, agents and desk items, or run an action"
          aria-label="Search the command palette"
          // the global :focus-visible outline is unlayered CSS, which a utility class cannot beat; the palette frames the field itself
          style={{ outline: 'none' }}
          className="h-12 w-full rounded-none border-0 bg-transparent text-base text-fg shadow-none placeholder:text-subtle focus:outline-none focus-visible:outline-none"
        />
      </div>
      <Command.List className="min-h-0 flex-1 overflow-y-auto p-2">
        <Command.Empty className="px-3 py-8 text-center text-sm text-subtle">
          {debounced.trim().length >= 2 && cards.isFetching ? 'Searching…' : 'Nothing matches.'}
        </Command.Empty>

        <Command.Group heading={<GroupHeading>Actions</GroupHeading>}>
          <Item
            value="action new card"
            keywords={['create', 'add', 'card']}
            icon={PlusCircle}
            hint="n"
            onSelect={go(ctx.projectKey ? `/cards/new?project=${ctx.projectKey}` : '/cards/new')}
          >
            New card
          </Item>
          <Item
            value="action start intake"
            keywords={['jira', 'github', 'ticket', 'import']}
            icon={FileText}
            onSelect={go('/intake')}
          >
            Start an intake
          </Item>
          <Item
            value="action chat with an agent"
            keywords={['talk', 'message']}
            icon={MessageSquare}
            onSelect={run(ctx.onChat)}
          >
            Chat with an agent
          </Item>
          <Item
            value="action toggle theme"
            keywords={['dark', 'light', 'mode', 'appearance']}
            icon={dark ? Sun : Moon}
            hint={theme === 'system' ? 'now: system' : `now: ${theme}`}
            onSelect={run(() => setTheme(dark ? 'light' : 'dark'))}
          >
            Toggle theme ({dark ? 'switch to light' : 'switch to dark'})
          </Item>
          <Item
            value="action help centre articles search glossary"
            keywords={['help', 'docs', 'documentation', 'guide', 'how', 'learn']}
            icon={LifeBuoy}
            onSelect={go('/help')}
          >
            Help
          </Item>
          <Item
            value="action what is on this page help"
            keywords={['help', 'explain', 'controls', 'page']}
            icon={HelpCircle}
            onSelect={run(() => ctx.onPageHelp?.())}
          >
            What is on this page
          </Item>
          {tour.available && (
            <Item
              value="action take the tour replay onboarding"
              keywords={['help', 'tour', 'welcome', 'walkthrough', 'onboarding']}
              icon={GraduationCap}
              onSelect={run(tour.start)}
            >
              Take the tour
            </Item>
          )}
          <Item
            value="action contact us support"
            keywords={['help', 'bug', 'question', 'feature', 'billing', 'report', 'feedback']}
            icon={MessageCircleQuestion}
            onSelect={run(() => ctx.onContact?.())}
          >
            Contact us
          </Item>
          <Item
            value="action my requests support tickets"
            keywords={['help', 'replies', 'answers']}
            icon={Inbox}
            onSelect={go('/help/requests')}
          >
            My requests
          </Item>
          <Item
            value="action keyboard shortcuts help"
            keywords={['keys', 'hotkeys', '?']}
            icon={Keyboard}
            hint="?"
            onSelect={run(ctx.onHelp)}
          >
            Keyboard shortcuts
          </Item>
        </Command.Group>

        <Command.Group heading={<GroupHeading>Pages</GroupHeading>}>
          {[...ctx.sections.flatMap((s) => s.items), ...ctx.footer]
            .filter((e) => e.id !== 'help')
            .map((e) => (
              <Item key={e.id} value={`page ${e.label}`} icon={e.icon} onSelect={go(e.to)}>
                {e.label}
              </Item>
            ))}
        </Command.Group>

        {ctx.projects.length > 0 && (
          <Command.Group heading={<GroupHeading>Projects</GroupHeading>}>
            {ctx.projects.map((p) => (
              <Item
                key={p.id}
                value={`project ${p.key} ${p.name}`}
                icon={FolderKanban}
                hint={p.key}
                onSelect={go(`/p/${p.key}/board`)}
              >
                {p.name}
              </Item>
            ))}
          </Command.Group>
        )}

        {(cards.data?.length ?? 0) > 0 && (
          <Command.Group heading={<GroupHeading>Cards</GroupHeading>}>
            {cards.data?.map((c) => (
              <Item
                key={c.id}
                value={`card ${c.ref} ${c.title}`}
                icon={FileText}
                hint={`${c.projectKey} · ${c.status}`}
                onSelect={go(`/cards/${c.ref}`)}
              >
                <span className="mr-2 font-mono text-xs font-medium text-muted">{c.ref}</span>
                {c.title}
              </Item>
            ))}
          </Command.Group>
        )}

        {(agents.data?.length ?? 0) > 0 && (
          <Command.Group heading={<GroupHeading>Agents</GroupHeading>}>
            {agents.data
              ?.filter((a) => a.status !== 'retired')
              .map((a) => (
                <Item
                  key={a.id}
                  value={`agent ${a.name} ${a.roleKey}`}
                  leading={<AgentAvatar agentId={a.id} name={a.name} size={20} />}
                  hint={a.roleKey}
                  onSelect={go(`/agents#${a.id}`)}
                >
                  {a.name}
                </Item>
              ))}
          </Command.Group>
        )}

        {(desk.data?.items.length ?? 0) > 0 && (
          <Command.Group heading={<GroupHeading>Desk</GroupHeading>}>
            {desk.data?.items.slice(0, 40).map((d) => (
              <Item
                key={d.id}
                value={`desk ${d.title} ${d.kind}`}
                icon={Inbox}
                hint={d.blocking ? `${d.kind} · blocking` : d.kind}
                onSelect={go(`/desk#${d.id}`)}
              >
                {d.title}
              </Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2 text-xs text-subtle">
        <span className="inline-flex items-center gap-1.5">
          <HelpCircle aria-hidden="true" className="size-3.5" />
          Type to filter, arrows to move
        </span>
        <span className="inline-flex items-center gap-1.5">
          <CornerDownLeft aria-hidden="true" className="size-3.5" />
          Enter to open · Esc to close
        </span>
      </div>
    </Command>
  );
}

/** Ctrl/Cmd+K: jump to pages, projects, cards, agents and desk items, or run an action. */
export function CommandPalette({
  open,
  onOpenChange,
  ctx,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ctx: PaletteContext;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-60 animate-fade bg-overlay" />
        <RadixDialog.Content
          aria-describedby={undefined}
          data-testid="command-palette"
          className={cx(
            'fixed z-70 overflow-hidden border border-line bg-surface shadow-lg',
            'max-sm:inset-x-0 max-sm:top-0 max-sm:rounded-b-dialog max-sm:pt-[env(safe-area-inset-top)]',
            'sm:top-[14vh] sm:left-1/2 sm:w-[min(92vw,40rem)] sm:-translate-x-1/2 sm:animate-rise sm:rounded-dialog',
          )}
        >
          <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
          <PaletteBody ctx={ctx} close={() => onOpenChange(false)} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
