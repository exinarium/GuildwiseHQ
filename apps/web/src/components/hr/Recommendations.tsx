import type { Recommendation, RoleUpdate } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApplyRecommendation, useResetRole } from '../../api/queries/hr.ts';
import { Badge, Button, Dialog, ErrorBox, Panel } from '../ui.tsx';

const KIND_LABEL: Record<Recommendation['kind'], string> = {
  blocked_ledger: 'Blocked',
  blocked_topic: 'Blocked',
  blocked_thin_specs: 'Blocked',
  rework_reason: 'Rework',
  model_up: 'Model up',
  model_down: 'Model down',
  split_role: 'Split the role',
  fire_idle: 'Fire or reassign',
  fire_quality: 'Fire or reassign',
  reviewer_strict: 'Reviewer',
};

const APPLY_LABEL: Record<Recommendation['action']['type'], string> = {
  change_model: 'Change model',
  standing_order: 'Propose standing order',
  split_role: 'Split role',
  fire: 'Fire',
  none: 'Advice only',
};

/** Rule-based recommendations with the evidence that triggered them; applying one performs the change through events. */
export function RecommendationList({ recommendations }: { recommendations: Recommendation[] }) {
  const apply = useApplyRecommendation();
  const [done, setDone] = useState<Record<string, { effect: string; deskItemId: string | null }>>({});
  // An applied recommendation disappears from the server's list at once: keep showing it with its outcome.
  const [applied, setApplied] = useState<Record<string, Recommendation>>({});
  const shown = [
    ...recommendations,
    ...Object.values(applied).filter((a) => !recommendations.some((r) => r.id === a.id)),
  ];
  if (shown.length === 0) return null;
  return (
    <section aria-label="Recommendations" data-testid="recommendations" className="mb-4">
      <h2 className="mb-3 text-lg font-semibold text-fg">Recommendations</h2>
      <ul className="flex flex-col gap-2">
        {shown.map((r) => (
          <li key={r.id} data-testid={`rec-${r.kind}`} data-rec-id={r.id}>
            <Panel className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="violet">{KIND_LABEL[r.kind]}</Badge>
                <p className="min-w-0 basis-full text-base font-medium text-fg sm:basis-0 sm:flex-1">
                  {r.title}
                </p>
                {done[r.id] ? (
                  <Badge tone="green">Applied</Badge>
                ) : r.action.type === 'none' ? (
                  <Badge>Advice only</Badge>
                ) : r.canApply ? (
                  <Button
                    variant="primary"
                    data-testid={`apply-${r.kind}`}
                    disabled={apply.isPending}
                    onClick={() =>
                      apply.mutate(r.id, {
                        onSuccess: (res) => {
                          setDone((d) => ({ ...d, [r.id]: res }));
                          setApplied((a) => ({ ...a, [r.id]: r }));
                          // keep the outcome on screen for a moment, then let the server's list win
                          setTimeout(
                            () =>
                              setApplied((a) => {
                                const { [r.id]: _gone, ...rest } = a;
                                return rest;
                              }),
                            3000,
                          );
                        },
                      })
                    }
                  >
                    {APPLY_LABEL[r.action.type]}
                  </Button>
                ) : (
                  <Badge title="Only the owner or the manager who hired the agent can apply this">
                    Not yours to apply
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted">{r.summary}</p>
              {r.action.type === 'standing_order' && (
                <p
                  className="rounded-control bg-sunken px-3 py-2 text-sm text-muted italic"
                  data-testid="rec-proposal"
                >
                  Proposed standing order: {r.action.text}
                </p>
              )}
              <details>
                <summary className="cursor-pointer text-sm font-medium text-muted hover:text-fg">
                  Evidence
                </summary>
                <ul className="mt-2 list-disc pl-5 text-sm text-muted" data-testid="rec-evidence">
                  {r.evidence.metrics.map((m) => (
                    <li key={m.label}>
                      {m.label}: <span className="font-medium">{m.value}</span>
                    </li>
                  ))}
                  {r.evidence.items.map((i) => (
                    <li key={`${i.ref ?? ''}${i.text}`}>
                      {i.ref && (
                        <Link to={`/cards/${i.ref}`} className="mr-1 underline">
                          {i.ref}
                        </Link>
                      )}
                      {i.text}
                    </li>
                  ))}
                </ul>
              </details>
              {done[r.id] && (
                <p className="text-sm text-success" data-testid="rec-applied">
                  {done[r.id]?.effect}.{' '}
                  {done[r.id]?.deskItemId && (
                    <Link to="/desk" className="underline">
                      Approve it on the desk
                    </Link>
                  )}
                </p>
              )}
            </Panel>
          </li>
        ))}
      </ul>
      <ErrorBox error={apply.error} />
    </section>
  );
}

/** Built-in roles whose shipped default moved on since the owner extended them; reset drops the extensions. */
export function RoleUpdates({ updates }: { updates: RoleUpdate[] }) {
  const [open, setOpen] = useState<RoleUpdate | null>(null);
  const reset = useResetRole();
  if (updates.length === 0) return null;
  const ext = open?.extensions;
  return (
    <section aria-label="Role updates" data-testid="role-updates" className="mb-4">
      <h2 className="mb-3 text-lg font-semibold text-fg">New defaults for built-in roles</h2>
      <ul className="flex flex-col gap-2">
        {updates.map((u) => (
          <li key={u.roleKey} data-testid={`role-update-${u.roleKey}`}>
            <Panel className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-base text-fg">
                <span className="font-medium">{u.roleName}</span> has a new default (version {u.latestVersion}
                )
                {u.extensionBaseVersion !== null
                  ? `; your extensions were written for version ${u.extensionBaseVersion}.`
                  : '.'}
                {u.agentsOnOlderVersion > 0 &&
                  ` ${u.agentsOnOlderVersion} agent${u.agentsOnOlderVersion === 1 ? ' is' : 's are'} still on the old version.`}
              </p>
              <Button data-testid={`reset-${u.roleKey}`} onClick={() => setOpen(u)}>
                Reset to default
              </Button>
            </Panel>
          </li>
        ))}
      </ul>
      <Dialog
        open={!!open}
        onOpenChange={(o) => !o && setOpen(null)}
        title={`Reset ${open?.roleName ?? ''} to the new default?`}
        description="Resetting drops your extensions for this role. Review what will be removed."
      >
        {open && ext && (
          <div className="flex flex-col gap-3">
            <div
              data-testid="reset-diff"
              className="rounded-control border border-danger-fill/30 bg-danger-soft p-2 text-sm"
            >
              <p className="mb-1 font-medium">Will be removed</p>
              <ul className="list-disc pl-5">
                {ext.instructions.trim() && <li>Extra instructions: {ext.instructions}</li>}
                {ext.skills.map((s) => (
                  <li key={`skill-${s}`}>Skill: {s}</li>
                ))}
                {ext.standingOrders.map((s) => (
                  <li key={`order-${s}`}>Standing order: {s}</li>
                ))}
                {!ext.instructions.trim() && ext.skills.length === 0 && ext.standingOrders.length === 0 && (
                  <li>Nothing: you have no extensions on this role.</li>
                )}
              </ul>
              <p className="mt-2 text-xs text-muted">
                The role's core rules do not change. Its agents move to version {open.latestVersion}.
              </p>
            </div>
            <ErrorBox error={reset.error} />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setOpen(null)}>Cancel</Button>
              <Button
                variant="danger"
                data-testid="confirm-reset"
                disabled={reset.isPending}
                onClick={() => reset.mutate(open.roleKey, { onSuccess: () => setOpen(null) })}
              >
                Reset and drop extensions
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </section>
  );
}
