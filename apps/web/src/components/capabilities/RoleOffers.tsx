import type { RoleOfferDto, RoleOfferReview } from '@aom/shared';
import { useState } from 'react';
import {
  useAcceptRoleOffer,
  useDismissRoleOffer,
  useReviewRoleOffer,
  useRoleOffers,
} from '../../api/queries/my-capabilities.ts';
import { diffLines } from '../../lib/diff-lines.ts';
import { Button, Callout, Dialog, ErrorBox, useToast } from '../ui.tsx';

/**
 * A pack update changed a persona an agent was hired from. A new role version is on offer; it is never applied by itself: review
 * the change in the instructions, then accept (the agents of the role follow it) or dismiss.
 */
export function RoleOffers() {
  const q = useRoleOffers();
  const [reviewing, setReviewing] = useState<RoleOfferDto | null>(null);
  const dismiss = useDismissRoleOffer();
  const items = q.data ?? [];
  if (items.length === 0) return null;
  return (
    <div className="mb-4 flex flex-col gap-2" data-testid="role-offers">
      {items.map((o) => (
        <Callout
          key={o.roleKey}
          tone="info"
          title={`${o.roleName}: a new version is on offer`}
          data-testid={`role-offer-${o.roleKey}`}
          actions={
            <>
              <Button size="sm" variant="primary" onClick={() => setReviewing(o)}>
                Review the change
              </Button>
              <Button size="sm" loading={dismiss.isPending} onClick={() => dismiss.mutate(o.roleKey)}>
                Not now
              </Button>
            </>
          }
        >
          The pack {o.packName} changed the persona this role came from ({o.newLabel}). {o.agentCount} agent
          {o.agentCount === 1 ? '' : 's'} run it at version {o.fromVersion} and keep it until you accept.
        </Callout>
      ))}
      {reviewing && <ReviewDialog offer={reviewing} onClose={() => setReviewing(null)} />}
    </div>
  );
}

function ReviewDialog({ offer, onClose }: { offer: RoleOfferDto; onClose: () => void }) {
  const review = useReviewRoleOffer();
  const accept = useAcceptRoleOffer();
  const toast = useToast();
  const [r, setR] = useState<RoleOfferReview | null>(null);
  const load = () => review.mutate(offer.roleKey, { onSuccess: setR });
  const lines = r?.current != null && r.proposed != null ? diffLines(r.current, r.proposed) : [];
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${offer.roleName}: ${offer.newLabel}`}
      description="The instructions of the role now, and as the updated persona would make them. Agents of this role move to the new version when you accept."
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {!r ? (
            <Button variant="primary" onClick={load} loading={review.isPending} data-testid="load-diff">
              Read the new version
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={accept.isPending}
              data-testid="accept-offer"
              onClick={() =>
                accept.mutate(
                  { roleKey: offer.roleKey, requestId: r.requestId },
                  {
                    onSuccess: (res) => {
                      toast.success(
                        `Version ${res.version} is in use${res.movedAgents ? `: ${res.movedAgents} agent(s) moved` : ''}.`,
                      );
                      onClose();
                    },
                  },
                )
              }
            >
              Accept the new version
            </Button>
          )}
        </>
      }
    >
      {!r && (
        <p className="text-sm text-muted">
          A workstation that holds the pack reads the updated persona; nothing changes yet.
        </p>
      )}
      <ErrorBox error={review.error ?? accept.error} />
      {r && (
        <pre
          className="max-h-[50vh] overflow-auto rounded-card border border-line bg-sunken p-3 text-xs"
          data-testid="role-diff"
        >
          {lines.map((l, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: a diff is read in order
              key={i}
              data-kind={l.kind}
              className={
                l.kind === 'add'
                  ? 'bg-success-subtle'
                  : l.kind === 'del'
                    ? 'bg-danger-subtle line-through'
                    : ''
              }
            >
              {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
              {l.text}
            </div>
          ))}
        </pre>
      )}
    </Dialog>
  );
}
