import type { DeskItemDto } from '@aom/shared';
import { Bot, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  useAcknowledgeAllCeoDecisions,
  useAcknowledgeCeoDecision,
  useCorrectCeoDecision,
} from '../../api/queries/desk.ts';
import { pct } from '../../lib/ceo.ts';
import { useActiveOrgRole } from '../../lib/orgRole.ts';
import { ageLabel, formatDateTime } from '../../lib/time.ts';
import { cx } from '../ui/cx.ts';
import { Badge, Button, Callout, Dialog, ErrorBox, TextArea, useToast } from '../ui.tsx';

export const isCeoDecision = (i: Pick<DeskItemDto, 'subkind'>): boolean => i.subkind === 'ceo_decision';

/** Owner or Admin: the same people who may answer an organization-level item. */
const useMayReview = (): boolean => {
  const role = useActiveOrgRole();
  return role === 'owner' || role === 'admin';
};

/** "Lesson recorded: ..." and the BA's analysis, once the owner corrected the decision. */
function CorrectionBlock({ item }: { item: DeskItemDto }) {
  const c = item.ceoDecision?.correction;
  if (!c) return null;
  return (
    <div
      className="mt-3 rounded-control border border-warning-fill/40 bg-warning-soft p-3 text-sm text-warning-soft-fg"
      data-testid="ceo-correction"
    >
      <p className="font-semibold">You corrected this: {c.text}</p>
      {c.applied && <p className="mt-0.5">{c.applied}</p>}
      {c.review === 'done' && c.lesson ? (
        <p className="mt-1" data-testid="ceo-lesson">
          Lesson recorded: {c.lesson.replace(/^Lesson \([^)]*\):\s*/, '')}
        </p>
      ) : (
        <p className="mt-1 text-xs">
          {c.review === 'analysed'
            ? 'The BA reviewed it; the CEO is recording the lesson.'
            : 'The CEO and the BA are reviewing it.'}
        </p>
      )}
      {c.analysis && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs font-medium">The BA's analysis</summary>
          <p className="mt-1 whitespace-pre-wrap">{c.analysis}</p>
        </details>
      )}
    </div>
  );
}

/** One CEO decision: what was asked, what the CEO decided and why, with Acknowledge and Correct. */
export function CeoDecisionItem({
  item,
  now,
  bare = false,
}: {
  item: DeskItemDto;
  now?: number;
  bare?: boolean;
}) {
  const d = item.ceoDecision;
  const may = useMayReview();
  const toast = useToast();
  const ack = useAcknowledgeCeoDecision();
  const [correcting, setCorrecting] = useState(false);
  if (!d) return null;
  const open = item.status === 'open';
  return (
    <article
      {...(bare ? {} : { id: `desk-item-${item.id}` })}
      data-testid={`desk-item-${item.id}`}
      data-kind={item.kind}
      data-subkind="ceo_decision"
      aria-label={item.title}
      className={cx(
        'rounded-card border border-line border-l-[3px] border-l-brand bg-surface p-4 shadow-sm sm:p-5',
        bare &&
          'max-md:-mx-4 max-md:-my-3 max-md:rounded-none max-md:border-0 max-md:border-l-[3px] max-md:shadow-none',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Badge tone="violet" icon={<Bot aria-hidden="true" />}>
          <span data-testid="ceo-decision-badge">CEO decision · {d.ceoName ?? 'CEO'}</span>
        </Badge>
        <span className="tnum ml-auto text-xs text-subtle" title={formatDateTime(item.createdAt)}>
          {ageLabel(item.createdAt, now)} ago
        </span>
      </div>
      {item.card && (
        <p className="mt-2 text-sm">
          <Link
            to={`/cards/${item.card.ref}`}
            className="text-brand-text hover:underline"
            data-testid="item-card"
          >
            <span className="font-mono text-xs">{item.card.ref}</span> {item.card.title}
          </Link>
        </p>
      )}
      <dl className="mt-3 space-y-2 text-sm">
        <div>
          <dt className="text-xs font-medium text-subtle">Asked</dt>
          <dd className="whitespace-pre-wrap text-fg" data-testid="ceo-decision-asked">
            {d.question}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-subtle">Decision</dt>
          <dd className="font-medium whitespace-pre-wrap text-fg" data-testid="ceo-decision-decided">
            {d.decision}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-subtle">Reason</dt>
          <dd className="whitespace-pre-wrap text-muted" data-testid="ceo-decision-reason">
            {d.reason}
            {d.confidence !== null && ` (confidence ${pct(d.confidence)})`}
          </dd>
        </div>
      </dl>
      <CorrectionBlock item={item} />
      {open && may && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="primary"
            loading={ack.isPending}
            data-testid="ceo-decision-ack"
            onClick={() =>
              ack.mutate(item.id, {
                onSuccess: () => toast.success('Marked as read'),
                onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not acknowledge'),
              })
            }
          >
            Acknowledge
          </Button>
          <Button data-testid="ceo-decision-correct" onClick={() => setCorrecting(true)}>
            Correct
          </Button>
        </div>
      )}
      <CorrectDialog item={item} open={correcting} onOpenChange={setCorrecting} />
    </article>
  );
}

/** The owner writes what the right decision is; the CEO remembers it and reviews it with the BA. */
export function CorrectDialog({
  item,
  open,
  onOpenChange,
}: {
  item: DeskItemDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const role = useActiveOrgRole();
  const toast = useToast();
  const correct = useCorrectCeoDecision();
  const [text, setText] = useState('');
  const [applyNow, setApplyNow] = useState(false);
  const d = item.ceoDecision;
  // Undo exists for decisions taken through the CEO's own actions, and only the Owner may use it.
  const canApply = role === 'owner' && d?.source === 'act';
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Correct this decision"
      description="Say what the right decision is. The CEO writes it into its memory and reviews it with the BA, so it does not make the same mistake."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={correct.isPending}
            disabled={!text.trim()}
            data-testid="ceo-correct-submit"
            onClick={() =>
              correct.mutate(
                { id: item.id, body: { correction: text.trim(), applyNow: canApply && applyNow } },
                {
                  onSuccess: (r) => {
                    toast.success(r.applied ?? 'Thanks. The CEO will learn from this.');
                    setText('');
                    setApplyNow(false);
                    onOpenChange(false);
                  },
                },
              )
            }
          >
            Send correction
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {d && (
          <p className="text-sm text-muted">
            The CEO decided: <span className="text-fg">{d.decision}</span>
          </p>
        )}
        <TextArea
          label="The right decision"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          data-testid="ceo-correct-text"
        />
        {canApply && (
          <label className="flex items-start gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              checked={applyNow}
              onChange={(e) => setApplyNow(e.target.checked)}
              data-testid="ceo-correct-apply"
            />
            <span>
              Apply the correction now (undo the decision, so the question is open again on your desk)
            </span>
          </label>
        )}
        <ErrorBox error={correct.error} />
      </div>
    </Dialog>
  );
}

/** The phone list row of a CEO decision; tapping opens it full screen. */
export function CeoDecisionCard({
  item,
  now,
  onOpen,
}: {
  item: DeskItemDto;
  now?: number;
  onOpen: () => void;
}) {
  const d = item.ceoDecision;
  return (
    <button
      type="button"
      id={`desk-item-${item.id}`}
      data-testid={`desk-card-${item.id}`}
      data-kind={item.kind}
      aria-label={item.title}
      onClick={onOpen}
      className="flex min-h-14 w-full items-center gap-3 rounded-card border border-line border-l-[3px] border-l-brand bg-surface p-3 text-left shadow-sm active:bg-sunken"
    >
      <span className="min-w-0 flex-1">
        <Badge tone="violet" icon={<Bot aria-hidden="true" />}>
          CEO decision · {d?.ceoName ?? 'CEO'}
        </Badge>
        <span className="mt-1.5 line-clamp-2 block text-base font-semibold [overflow-wrap:anywhere] text-fg">
          {d?.decision ?? item.title}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-subtle">
          {item.card && <span className="font-mono">{item.card.ref}</span>}
          <span className="tnum">{ageLabel(item.createdAt, now)} ago</span>
        </span>
      </span>
      <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-subtle" />
    </button>
  );
}

/** The "CEO decisions" section of the desk: the open ones, with Acknowledge all. */
export function CeoDecisionsSection({
  items,
  mobile,
  onOpen,
  now,
}: {
  items: DeskItemDto[];
  mobile: boolean;
  onOpen: (id: string) => void;
  now?: number;
}) {
  const may = useMayReview();
  const toast = useToast();
  const all = useAcknowledgeAllCeoDecisions();
  if (items.length === 0) return null;
  return (
    <section aria-label="CEO decisions" data-testid="ceo-decisions">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-muted">
          CEO decisions
          <span className="tnum rounded-full bg-sunken px-2 text-xs font-medium">{items.length}</span>
        </h3>
        {may && (
          <Button
            size="sm"
            className="ml-auto"
            loading={all.isPending}
            data-testid="ceo-decisions-ack-all"
            onClick={() =>
              all.mutate(undefined, {
                onSuccess: (r) =>
                  toast.success(
                    `${r.acknowledged} CEO decision${r.acknowledged === 1 ? '' : 's'} marked as read`,
                  ),
              })
            }
          >
            Acknowledge all
          </Button>
        )}
      </div>
      <p className="mb-2 text-xs text-subtle">
        Things the CEO decided for you. Acknowledge them, or correct one that is wrong so the CEO learns.
      </p>
      {all.error && (
        <Callout tone="warning">{all.error instanceof Error ? all.error.message : 'Failed'}</Callout>
      )}
      <ol className="flex flex-col gap-3" aria-label="CEO decisions items">
        {items.map((item) => (
          <li key={item.id}>
            {mobile ? (
              <CeoDecisionCard item={item} onOpen={() => onOpen(item.id)} {...(now ? { now } : {})} />
            ) : (
              <CeoDecisionItem item={item} {...(now ? { now } : {})} />
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
