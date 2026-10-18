import { Bell, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useMe } from '../../api/queries/auth.ts';
import { usePushSubscription } from '../../hooks/usePushSubscription.ts';
import {
  askDismissed,
  dismissHint,
  hintDismissed,
  markPromptShown,
  neverAsk,
  promptShownThisSession,
  snoozeAsk,
} from '../../lib/pushPrompt.ts';
import { isIos, isStandalone } from '../../lib/pwa.ts';
import { useTour } from '../tour/TourContext.tsx';
import { Button, useToast } from '../ui.tsx';

type Kind = 'ask' | 'ios';

const DELAY_MS = 3000;
const RECHECK_MS = 2000;
const dialogOpen = () => !!document.querySelector('[role="dialog"], [role="alertdialog"]');

/**
 * Asks signed-in people to turn notifications on, once per session. The permission is requested inside the
 * "Turn on" click (browsers and iOS refuse it otherwise). On an iPhone or iPad in Safari it shows the
 * Add-to-Home-Screen hint instead, because iOS only does Web Push for an installed app.
 */
export function PushPrompt() {
  const me = useMe();
  const tour = useTour();
  const push = usePushSubscription();
  const toast = useToast();
  const [kind, setKind] = useState<Kind | null>(null);
  const [gone, setGone] = useState(false);

  const signedIn = !!me.data;
  const tourBusy = tour.active || (tour.available && tour.status === 'new');
  const eligible: Kind | null = (() => {
    if (!signedIn || push.serverEnabled !== true || !push.checked || push.here) return null;
    if (isIos() && !isStandalone()) return hintDismissed() ? null : 'ios';
    if (push.support !== 'ready' || Notification.permission !== 'default' || askDismissed()) return null;
    return 'ask';
  })();

  useEffect(() => {
    if (!eligible || tourBusy || gone || kind || promptShownThisSession()) return;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () => {
      if (dialogOpen()) {
        timer = setTimeout(attempt, RECHECK_MS);
        return;
      }
      markPromptShown();
      setKind(eligible);
    };
    timer = setTimeout(attempt, DELAY_MS);
    return () => clearTimeout(timer);
  }, [eligible, tourBusy, gone, kind]);

  if (!kind || gone) return null;

  const close = () => setGone(true);
  const turnOn = async () => {
    // requestPermission runs synchronously inside this click handler (see enablePush).
    const ok = await push.enable();
    if (ok) {
      toast.success('Notifications are on. Send a test from Settings.');
      close();
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      snoozeAsk();
      close();
    }
  };

  return (
    <section
      aria-label={kind === 'ios' ? 'Add to Home Screen' : 'Turn on notifications'}
      data-testid={kind === 'ios' ? 'push-ios-card' : 'push-prompt'}
      className="fixed inset-x-3 bottom-[calc(var(--app-bottom-inset,0px)+0.75rem)] z-40 rounded-card border border-line bg-surface p-4 shadow-lg md:inset-x-auto md:right-4 md:bottom-4 md:w-96"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-sunken text-fg"
        >
          <Bell className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          {kind === 'ios' ? (
            <>
              <h2 className="text-base font-semibold text-fg">
                Add Guildwise to your Home Screen to get notifications
              </h2>
              <p className="mt-1 text-sm text-muted">
                iPhone and iPad only allow notifications for apps on the Home Screen (iOS 16.4 or later). In
                Safari tap Share, then Add to Home Screen, then open Guildwise from its icon.
              </p>
              <div className="mt-3">
                <Button
                  size="sm"
                  data-testid="push-ios-dismiss"
                  onClick={() => {
                    dismissHint();
                    close();
                  }}
                >
                  Got it
                </Button>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-fg">Turn on notifications</h2>
              <p className="mt-1 text-sm text-muted">
                Get told when an agent has a blocking question, something needs your approval, or a runner
                needs attention. You can choose what in Settings.
              </p>
              {push.problem && (
                <p role="alert" className="mt-2 text-sm text-danger">
                  {push.problem}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  loading={push.busy}
                  data-testid="push-prompt-on"
                  onClick={turnOn}
                >
                  Turn on
                </Button>
                <Button
                  size="sm"
                  data-testid="push-prompt-later"
                  onClick={() => {
                    snoozeAsk();
                    close();
                  }}
                >
                  Not now
                </Button>
                <button
                  type="button"
                  data-testid="push-prompt-never"
                  className="min-h-9 px-1 text-sm text-muted underline hover:text-fg"
                  onClick={() => {
                    neverAsk();
                    close();
                  }}
                >
                  Don't ask again on this device
                </button>
              </div>
            </>
          )}
        </div>
        <button
          type="button"
          aria-label="Close"
          data-testid="push-prompt-close"
          className="-mt-1 -mr-1 inline-flex size-9 shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-fg"
          onClick={() => {
            if (kind === 'ios') dismissHint();
            else snoozeAsk();
            close();
          }}
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
    </section>
  );
}
