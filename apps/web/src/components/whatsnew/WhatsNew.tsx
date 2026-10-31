import { useMemo } from 'react';
import { Link, useLocation } from 'react-router';
import { useMe } from '../../api/queries/auth.ts';
import { useMarkWhatsNewSeen } from '../../api/queries/whatsNew.ts';
import { helpBase } from '../../help/articles.ts';
import { Markdown } from '../../help/Markdown.tsx';
import { useOrgTerms } from '../../lib/terms.ts';
import { entriesFor, unseenFor, type WhatsNewEntry } from '../../whats-new/entries.ts';
import { useTour } from '../tour/TourContext.tsx';
import { Button, Dialog } from '../ui.tsx';

const dateLabel = (d: string): string =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

/** The list of entries, newest first: title, date, body and a "Learn more" link to the help article. */
export function WhatsNewDialog({
  open,
  entries,
  onClose,
  confirmLabel = 'Got it',
}: {
  open: boolean;
  entries: WhatsNewEntry[];
  onClose: () => void;
  confirmLabel?: string;
}) {
  const base = helpBase(useLocation().pathname);
  const t = useOrgTerms();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="What’s new in Guildwise HQ"
      size="lg"
      footer={
        <Button variant="primary" onClick={onClose} data-testid="whats-new-got-it">
          {confirmLabel}
        </Button>
      }
    >
      {entries.length === 0 ? (
        <p className="text-base text-muted">Nothing new yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line" data-testid="whats-new-list">
          {entries.map((e) => (
            <li key={e.id} className="py-3 first:pt-0 last:pb-0" data-testid={`whats-new-${e.id}`}>
              <h3 className="text-base font-semibold text-fg">{t.reword(e.title)}</h3>
              <p className="mb-1 text-xs text-subtle">{dateLabel(e.date)}</p>
              <Markdown blocks={e.blocks} />
              {e.help && (
                <Link
                  to={`${base}${e.help.slice(5)}`}
                  onClick={onClose}
                  className="mt-1.5 inline-block text-sm font-medium text-brand-text underline-offset-2 hover:underline"
                >
                  Learn more
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/**
 * Opens "What's new in Guildwise HQ" after a sign-in or load when there are entries for this user they have not seen.
 * It never opens on top of the first-login tour: it waits until the tour is closed. "Got it" (or closing it) marks
 * everything shown as seen, on the server, so it stays closed on every device.
 */
export function WhatsNewHost() {
  const me = useMe();
  const tour = useTour();
  const mark = useMarkWhatsNewSeen();
  const pending = useMemo(() => (me.data ? unseenFor(me.data) : []), [me.data]);
  const tourBusy = tour.active || (tour.available && tour.status === 'new');
  const enabled = me.data?.features.whatsNew === true && !tourBusy;
  if (!enabled || pending.length === 0) return null;
  return <WhatsNewDialog open entries={pending} onClose={() => mark.mutate(pending.map((e) => e.id))} />;
}

/** The whole list for the user, for the Help page ("What's new"), reopened at any time; closing it marks nothing. */
export function useAllWhatsNew(): WhatsNewEntry[] {
  const me = useMe();
  return useMemo(() => (me.data ? entriesFor(me.data) : []), [me.data]);
}
