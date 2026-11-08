import { Ellipsis, FolderKanban, Inbox, MessageSquare, MessagesSquare, Plus, SquarePen } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { isTurnInFlight, TURN_IN_FLIGHT_TEXT, useCeoStatus, useStartCeoChat } from '../../api/queries/ceo.ts';
import { useUnreadChatTotal } from '../../api/queries/chats.ts';
import { ceoChatPath } from '../../lib/openCeoChat.ts';
import { useActiveOrgRole } from '../../lib/orgRole.ts';
import { useKeyboardOpen } from '../../lib/viewport.ts';
import { BottomSheet } from '../ui/BottomSheet.tsx';
import { cx } from '../ui/cx.ts';
import type { DeskCounts } from './Sidebar.tsx';

const tabClass = (active: boolean) =>
  cx(
    'relative flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium leading-none transition-colors',
    active ? 'text-brand-text' : 'text-muted',
  );

/** The unread chat total on the Chats tab and the desktop Chat button. */
export function UnreadBadge({
  count,
  testId,
  className,
}: {
  count: number;
  testId: string;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      data-testid={testId}
      role="img"
      aria-label={`${count > 99 ? '99+' : count} unread`}
      className={cx(
        'tnum absolute -top-1.5 left-full -ml-2.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand px-1 text-xs font-semibold text-white',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function Badge({ counts }: { counts: DeskCounts }) {
  if (counts.open <= 0) return null;
  return (
    <span
      data-testid="tab-desk-badge"
      title={`${counts.blocking} blocking, ${counts.open} open`}
      className={cx(
        'tnum absolute -top-1.5 left-full -ml-2.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-xs font-semibold',
        counts.blocking > 0 ? 'bg-danger-solid text-white' : 'bg-accent text-accent-fg',
      )}
    >
      {counts.open > 99 ? '99+' : counts.open}
    </span>
  );
}

/**
 * The phone's navigation: Desk, Chats, the Intake/New button in the middle, Projects and More. The last child of the phone app frame
 * (AppShell), under the scrolling content, so it never moves with the page. Safe-area aware; `--app-bottom-inset` (index.css)
 * is its height for fixed elements.
 */
export function MobileTabBar({
  counts,
  intake,
  chatsOpen,
  moreOpen,
  onChats,
  onMore,
}: {
  counts: DeskCounts;
  /** Where the centre button goes: the intake page for managers, a new card for everyone else. */
  intake: { to: string; label: string };
  chatsOpen: boolean;
  moreOpen: boolean;
  onChats: () => void;
  onMore: () => void;
}) {
  const { pathname } = useLocation();
  const nav = useNavigate();
  const owner = useActiveOrgRole() === 'owner';
  const ceoStatus = useCeoStatus(owner);
  const newCeoChat = useStartCeoChat();
  const [chooser, setChooser] = useState(false);
  const cs = ceoStatus.data;
  /** The CEO's name when the Owner has an active CEO: the middle button then offers a choice (Intake or a new CEO chat). */
  const ceoName =
    owner && cs?.hired && cs.agent && cs.state !== 'disabled' && cs.state !== 'none' ? cs.agent.name : null;
  /** Intake is only there with integrations on; otherwise the button writes a card. */
  const isIntake = intake.to.startsWith('/intake');
  const unreadChats = useUnreadChatTotal();
  const keyboard = useKeyboardOpen();
  const overlay = chatsOpen || moreOpen;
  const deskActive = !overlay && (pathname === '/desk' || pathname.startsWith('/desk/'));
  const projectsActive =
    !overlay &&
    (pathname.startsWith('/projects') || pathname.startsWith('/p/') || pathname.startsWith('/cards/'));
  const intakeActive = !overlay && (pathname === intake.to.split('?')[0] || pathname.startsWith('/intake'));
  if (keyboard) return null;
  return (
    <nav
      aria-label="Primary"
      data-testid="mobile-tabbar"
      className="relative z-40 shrink-0 border-t border-line bg-surface/95 pb-(--safe-bottom) pl-(--safe-left) pr-(--safe-right) backdrop-blur md:hidden"
    >
      <ul className="grid h-14 grid-cols-5 items-stretch">
        <li className="contents">
          <Link
            to="/desk"
            aria-current={deskActive ? 'page' : undefined}
            data-testid="tab-desk"
            className={tabClass(deskActive)}
          >
            <span className="relative">
              <Inbox aria-hidden="true" className="size-6" strokeWidth={deskActive ? 2.25 : 1.75} />
              <Badge counts={counts} />
            </span>
            Desk
          </Link>
        </li>
        <li className="contents">
          <button
            type="button"
            onClick={onChats}
            aria-haspopup="dialog"
            aria-expanded={chatsOpen}
            data-testid="tab-chats"
            className={tabClass(chatsOpen)}
          >
            <span className="relative">
              <MessageSquare aria-hidden="true" className="size-6" strokeWidth={chatsOpen ? 2.25 : 1.75} />
              <UnreadBadge count={unreadChats} testId="tab-chats-badge" />
            </span>
            Chats
          </button>
        </li>
        <li className="contents">
          {ceoName ? (
            <button
              type="button"
              onClick={() => setChooser(true)}
              aria-haspopup="dialog"
              aria-expanded={chooser}
              data-testid="tab-intake"
              className="relative flex min-h-14 flex-col items-center justify-end gap-0.5 pb-1.5 text-[11px] font-medium leading-none text-muted"
            >
              <span className="absolute -top-4 inline-flex size-12 items-center justify-center rounded-full bg-accent text-accent-fg shadow-md ring-4 ring-surface">
                <Plus aria-hidden="true" className="size-6" strokeWidth={2.5} />
              </span>
              <span className={intakeActive ? 'text-brand-text' : undefined}>New</span>
            </button>
          ) : (
            <Link
              to={intake.to}
              aria-current={intakeActive ? 'page' : undefined}
              data-testid="tab-intake"
              className="relative flex min-h-14 flex-col items-center justify-end gap-0.5 pb-1.5 text-[11px] font-medium leading-none text-muted"
            >
              <span
                className={cx(
                  'absolute -top-4 inline-flex size-12 items-center justify-center rounded-full bg-accent text-accent-fg shadow-md ring-4 ring-surface',
                  intakeActive && 'brightness-95',
                )}
              >
                <Plus aria-hidden="true" className="size-6" strokeWidth={2.5} />
              </span>
              <span className={intakeActive ? 'text-brand-text' : undefined}>{intake.label}</span>
            </Link>
          )}
        </li>
        <li className="contents">
          <Link
            to="/projects"
            aria-current={projectsActive ? 'page' : undefined}
            data-testid="tab-projects"
            className={tabClass(projectsActive)}
          >
            <FolderKanban aria-hidden="true" className="size-6" strokeWidth={projectsActive ? 2.25 : 1.75} />
            Projects
          </Link>
        </li>
        <li className="contents">
          <button
            type="button"
            onClick={onMore}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            data-testid="tab-more"
            className={tabClass(moreOpen)}
          >
            <Ellipsis aria-hidden="true" className="size-6" strokeWidth={moreOpen ? 2.25 : 1.75} />
            More
          </button>
        </li>
      </ul>
      <BottomSheet open={chooser} onOpenChange={setChooser} title="Start something" testId="new-chooser">
        <ul className="flex flex-col gap-2 pb-2">
          <li>
            <Link
              to={intake.to}
              onClick={() => setChooser(false)}
              data-testid="chooser-intake"
              className="flex min-h-14 items-center gap-3 rounded-card border border-line px-4 py-3 text-left hover:bg-sunken"
            >
              <SquarePen aria-hidden="true" className="size-5 shrink-0 text-muted" />
              <span>
                <span className="block text-base font-medium text-fg">
                  {isIntake ? 'Intake' : 'New card'}
                </span>
                <span className="block text-sm text-muted">
                  {isIntake
                    ? 'Describe the work and let the team plan it.'
                    : 'Write up a piece of work for the team.'}
                </span>
              </span>
            </Link>
          </li>
          <li>
            <button
              type="button"
              disabled={newCeoChat.isPending}
              data-testid="chooser-ceo-chat"
              onClick={() =>
                newCeoChat.mutate(undefined, {
                  onSuccess: (r) => {
                    setChooser(false);
                    nav(ceoChatPath(r.threadId));
                  },
                })
              }
              className="flex min-h-14 w-full items-center gap-3 rounded-card border border-line px-4 py-3 text-left hover:bg-sunken disabled:opacity-60"
            >
              <MessagesSquare aria-hidden="true" className="size-5 shrink-0 text-muted" />
              <span>
                <span className="block text-base font-medium text-fg">New chat with {ceoName}</span>
                <span className="block text-sm text-muted">Ask or tell your CEO something.</span>
              </span>
            </button>
          </li>
          {newCeoChat.error && (
            <li role="alert" className="px-1 text-sm text-danger" data-testid="chooser-error">
              {isTurnInFlight(newCeoChat.error) ? TURN_IN_FLIGHT_TEXT : 'Could not start a chat. Try again.'}
            </li>
          )}
        </ul>
      </BottomSheet>
    </nav>
  );
}
