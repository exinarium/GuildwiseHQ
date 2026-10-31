import * as RadixDialog from '@radix-ui/react-dialog';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useMe } from '../../api/queries/auth.ts';
import { useSetTour } from '../../api/queries/tour.ts';
import { useWorkstations } from '../../api/queries/workstations.ts';
import { helpBase, helpPath } from '../../help/articles.ts';
import { useOrgTerms } from '../../lib/terms.ts';
import { type TourStep, tourRoleOf, tourSteps, WORKSTATION_OFFER } from '../../lib/tour.ts';
import { videoForNav } from '../../lib/videos.ts';
import { Button } from '../ui.tsx';
import { type TourApi, TourContext } from './TourContext.tsx';
import { TourVideo } from './TourVideo.tsx';

/** How far the lit-up area reaches past the element, and the gap between it and the card. */
const PAD = 6;
const GAP = 14;
const EDGE = 12;
const CARD_W = 360;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const sameBox = (a: Box | null, b: Box | null): boolean =>
  a === b ||
  (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);

/** The element a step lights up, and where it is now (tracked every frame: the drawer slides, the page scrolls). */
function useTargetBox(target: string | undefined, active: boolean): { box: Box | null; found: boolean } {
  const [state, setState] = useState<{ box: Box | null; found: boolean }>({ box: null, found: false });
  useEffect(() => {
    if (!active || !target) {
      setState({ box: null, found: false });
      return;
    }
    let raf = 0;
    let scrolled = false;
    const tick = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
      if (el) {
        if (!scrolled) {
          scrolled = true;
          el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        }
        const r = el.getBoundingClientRect();
        const box =
          r.width > 0 || r.height > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
        setState((s) => (s.found && sameBox(s.box, box) ? s : { box, found: true }));
      } else setState((s) => (s.found || s.box ? { box: null, found: false } : s));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [target, active]);
  return state;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi));

/** Where the card goes: beside the lit-up element when there is room, else below or above it; a sheet on a phone. */
function place(
  box: Box | null,
  card: { w: number; h: number },
  vw: number,
  vh: number,
): { left: number; top: number; width: number } {
  if (vw < 640) {
    const width = vw - EDGE * 2;
    const lowTarget = box ? box.top + box.height / 2 > vh * 0.5 : false;
    return { left: EDGE, width, top: lowTarget ? EDGE : Math.max(EDGE, vh - card.h - EDGE) };
  }
  const width = Math.min(CARD_W, vw - EDGE * 2);
  if (!box) return { left: (vw - width) / 2, top: Math.max(EDGE, (vh - card.h) / 2), width };
  const cy = clamp(box.top + box.height / 2 - card.h / 2, EDGE, vh - card.h - EDGE);
  const cx = clamp(box.left + box.width / 2 - width / 2, EDGE, vw - width - EDGE);
  const right = box.left + box.width + PAD + GAP;
  if (right + width <= vw - EDGE) return { left: right, top: cy, width };
  const below = box.top + box.height + PAD + GAP;
  if (below + card.h <= vh - EDGE) return { left: cx, top: below, width };
  const above = box.top - PAD - GAP - card.h;
  if (above >= EDGE) return { left: cx, top: above, width };
  const left = box.left - PAD - GAP - width;
  if (left >= EDGE) return { left, top: cy, width };
  return { left: (vw - width) / 2, top: Math.max(EDGE, (vh - card.h) / 2), width };
}

function Card({
  step,
  index,
  total,
  box,
  found,
  offer,
  onNext,
  onBack,
  onSkip,
  onOffer,
  onRead,
}: {
  step: TourStep;
  index: number;
  total: number;
  box: Box | null;
  found: boolean;
  offer: boolean;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onOffer: () => void;
  onRead: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const t = useOrgTerms();
  const base = helpBase(useLocation().pathname);
  const [size, setSize] = useState({ w: CARD_W, h: 220 });
  const [videoShown, setVideoShown] = useState(false);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again whenever the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setSize((s) => (s.h === el.offsetHeight ? s : { w: el.offsetWidth, h: el.offsetHeight }));
  }, [step.id, vp.w, offer, videoShown]);
  const sectionVideo = videoForNav(step.videoNav ?? step.id);
  const last = index === total - 1;
  const at = place(found ? box : null, size, vp.w, vp.h);
  const pct = Math.round(((index + 1) / total) * 100);
  return (
    <RadixDialog.Content
      ref={ref}
      data-testid="tour"
      data-step={step.id}
      aria-labelledby="tour-title"
      aria-describedby="tour-body"
      onInteractOutside={(e) => e.preventDefault()}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        ref.current?.querySelector<HTMLElement>('[data-tour-primary]')?.focus();
      }}
      onEscapeKeyDown={(e) => {
        e.preventDefault();
        onSkip();
      }}
      style={{ left: at.left, top: at.top, width: at.width }}
      className="fixed z-[81] flex max-h-[calc(100dvh-24px)] flex-col gap-3 overflow-y-auto rounded-dialog border border-line bg-surface p-4 text-fg shadow-lg outline-none transition-[left,top] duration-200 ease-out motion-reduce:transition-none sm:p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <p
          className="tnum text-xs font-semibold tracking-wide text-brand-text uppercase"
          data-testid="tour-progress"
        >
          Step {index + 1} of {total}
        </p>
        <button
          type="button"
          onClick={onSkip}
          data-testid="tour-skip"
          className="-mr-2 inline-flex min-h-8 items-center rounded-control px-2 text-sm font-medium text-muted hover:bg-sunken hover:text-fg [@media(pointer:coarse)]:min-h-11"
        >
          Skip tour
        </button>
      </div>
      <div
        role="progressbar"
        aria-label="Tour progress"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={index + 1}
        aria-valuetext={`Step ${index + 1} of ${total}`}
        className="h-1 overflow-hidden rounded-full bg-sunken"
      >
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-200 motion-reduce:transition-none"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div aria-live="polite" className="flex flex-col gap-1.5">
        <RadixDialog.Title id="tour-title" data-testid="tour-title" className="text-lg font-semibold text-fg">
          {step.id === 'vaults' ? t.vaultsPage : t.reword(step.title)}
        </RadixDialog.Title>
        <RadixDialog.Description id="tour-body" className="text-base text-muted">
          {t.reword(step.body)}
          {last && offer && ` ${t.reword(WORKSTATION_OFFER.text)}`}
        </RadixDialog.Description>
        {step.video && <TourVideo onShown={setVideoShown} />}
        {!step.video && sectionVideo && (
          <TourVideo key={sectionVideo.slug} slug={sectionVideo.slug} onShown={setVideoShown} />
        )}
        {step.more && (
          <Link
            to={helpPath(step.more, base)}
            onClick={onRead}
            data-testid="tour-more"
            className="mt-0.5 w-fit text-sm font-medium text-brand-text underline-offset-2 hover:underline"
          >
            Read more in Help
          </Link>
        )}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        {index > 0 && (
          <Button variant="ghost" onClick={onBack} data-testid="tour-back" className="max-sm:w-full">
            Back
          </Button>
        )}
        {last && offer ? (
          <>
            <Button variant="secondary" onClick={onNext} data-testid="tour-next" className="max-sm:w-full">
              Not now
            </Button>
            <Button
              variant="primary"
              onClick={onOffer}
              data-tour-primary
              data-testid="tour-offer"
              className="max-sm:w-full"
            >
              {WORKSTATION_OFFER.label}
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            onClick={onNext}
            data-tour-primary
            data-testid="tour-next"
            className="max-sm:w-full"
          >
            {last ? 'Finish' : (step.nextLabel ?? 'Next')}
          </Button>
        )}
      </div>
    </RadixDialog.Content>
  );
}

/**
 * The first-login tour: a spotlight on the real elements of the screen, one step at a time, with Next, Back and Skip.
 * Where the user is in it is kept on the server (`me.user.tour`), so it does not come back on another device and a
 * skipped or interrupted tour can be resumed from Help. `onDrawer` opens the menu drawer on a phone for the steps that
 * point into the sidebar.
 */
export function TourProvider({
  navIds,
  mobile,
  onDrawer,
  onActive,
  children,
}: {
  /** The sidebar entries this user has (a role-limited or switched-off page is not in the tour either). */
  navIds: ReadonlySet<string>;
  mobile: boolean;
  onDrawer?: (open: boolean) => void;
  /** Told when the tour opens or closes (the drawer lets go of its focus trap while it runs). */
  onActive?: (active: boolean) => void;
  children?: ReactNode;
}) {
  const me = useMe();
  const nav = useNavigate();
  const save = useSetTour();
  const role = tourRoleOf(me.data);
  const hasTour = !!me.data?.user.tour && !!role;
  const workstations = useWorkstations({ enabled: hasTour && role !== 'platform' });
  const noWorkstation =
    role !== 'platform' && workstations.isSuccess && !workstations.data.some((w) => w.status === 'active');
  const navKey = [...navIds].sort().join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: navKey is navIds by value
  const steps = useMemo(() => (role ? tourSteps(role, navIds) : []), [role, navKey]);
  const total = steps.length;
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const auto = useRef(false);
  const saved = me.data?.user.tour;

  const persist = useCallback(
    (status: 'in_progress' | 'completed' | 'dismissed', step: number) => save.mutate({ status, step }),
    [save],
  );

  // First visit only: open it once. It is recorded as started at once, so a later login (after the tab was closed
  // mid-tour, say) does not show it again; an unfinished tour is resumed from Help.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per load, when the saved state arrives
  useEffect(() => {
    if (auto.current || !saved || total === 0) return;
    if (saved.status === 'new') {
      auto.current = true;
      setIndex(0);
      setActive(true);
      persist('in_progress', 0);
    }
  }, [saved?.status, total]);

  const step = steps[Math.min(index, total - 1)];
  useEffect(() => {
    onActive?.(active);
    if (!active) onDrawer?.(false);
  }, [active, onActive, onDrawer]);
  useEffect(() => {
    if (active && mobile) onDrawer?.(!!step?.drawer);
  }, [active, mobile, step, onDrawer]);

  const { box, found } = useTargetBox(step?.target, active);

  const go = (to: number) => {
    setIndex(to);
    persist('in_progress', to);
  };
  const close = (status: 'completed' | 'dismissed', at: number) => {
    setActive(false);
    persist(status, at);
  };

  const api: TourApi = {
    available: hasTour,
    active,
    status: saved?.status ?? 'completed',
    step: saved?.step ?? 0,
    total,
    start: () => {
      if (total === 0) return;
      setIndex(0);
      setActive(true);
      persist('in_progress', 0);
    },
    resume: () => {
      if (total === 0) return;
      const at = Math.min(saved?.step ?? 0, total - 1);
      setIndex(at);
      setActive(true);
      persist('in_progress', at);
    },
  };

  return (
    <TourContext.Provider value={api}>
      {children}
      {step && (
        <RadixDialog.Root open={active}>
          <RadixDialog.Portal>
            <RadixDialog.Overlay
              data-testid="tour-backdrop"
              className={`fixed inset-0 z-80 ${found && box ? '' : 'bg-overlay'}`}
            />
            {found && box && (
              <div
                aria-hidden="true"
                data-testid="tour-spotlight"
                className="pointer-events-none fixed z-80 rounded-[12px] transition-[left,top,width,height] duration-200 ease-out motion-reduce:transition-none"
                style={{
                  left: box.left - PAD,
                  top: box.top - PAD,
                  width: box.width + PAD * 2,
                  height: box.height + PAD * 2,
                  boxShadow: '0 0 0 3px var(--accent), 0 0 0 100vmax var(--overlay)',
                }}
              />
            )}
            <Card
              step={step}
              index={Math.min(index, total - 1)}
              total={total}
              box={box}
              found={found}
              offer={noWorkstation}
              onNext={() => (index >= total - 1 ? close('completed', total - 1) : go(index + 1))}
              onBack={() => go(Math.max(0, index - 1))}
              onSkip={() => close('dismissed', index)}
              onOffer={() => {
                close('completed', total - 1);
                nav(WORKSTATION_OFFER.to);
              }}
              onRead={() => close('dismissed', index)}
            />
          </RadixDialog.Portal>
        </RadixDialog.Root>
      )}
    </TourContext.Provider>
  );
}
