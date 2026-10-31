import { ENFORCED_BY_EXPLAIN, type EnforcedBy, type RulePackPreview } from '@aom/shared';
import { useState } from 'react';
import {
  useInstallRulePack,
  useRemoveRulePack,
  useRulePackPreview,
  useRulePacks,
} from '../api/queries/ledger.ts';
import { useCanManageOrg } from '../lib/orgRole.ts';
import { useOrgTerms } from '../lib/terms.ts';
import { EnforcedByBadge } from './EnforcedByBadge.tsx';
import { Badge, Button, ConfirmDialog, Dialog, ErrorBox, ListSkeleton, useToast } from './ui.tsx';

type PreviewRule = RulePackPreview['rules'][number];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function statusLine(r: PreviewRule): string | null {
  const first = r.existing[0]?.title ?? '';
  switch (r.status) {
    case 'installed':
      return 'Already installed';
    case 'edited':
      return 'You edited this rule';
    case 'covered':
      return `Covered by your rule "${first}" (not added)`;
    case 'may_conflict':
      return `May contradict "${r.existing.map((x) => x.title).join('", "')}"`;
    default:
      return null;
  }
}

function PackPreview({ packId, onBack }: { packId: string; onBack: () => void }) {
  const t = useOrgTerms();
  const toast = useToast();
  const preview = useRulePackPreview(packId);
  const install = useInstallRulePack();
  const remove = useRemoveRulePack();
  const canManage = useCanManageOrg();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const p = preview.data;
  const allIn = !!p && p.rules.every((r) => r.status !== 'new' && r.status !== 'may_conflict');
  const err = install.error ?? remove.error;
  return (
    <div data-testid="rule-pack-preview" className="flex flex-col gap-3">
      <div>
        <Button size="sm" variant="ghost" onClick={onBack}>
          All packs
        </Button>
      </div>
      {preview.isPending && <ListSkeleton label="Loading the pack" />}
      <ErrorBox error={preview.error} onRetry={() => preview.refetch()} />
      {p && (
        <>
          <div>
            <h3 className="text-lg font-semibold text-fg">{p.name}</h3>
            <p className="text-sm text-muted">{p.description}</p>
          </div>
          <p className="text-sm text-subtle" data-testid="enforced-by-legend">
            <strong>Guildwise (server check)</strong>: {ENFORCED_BY_EXPLAIN.server_check}{' '}
            <strong>Agent instruction</strong>: {ENFORCED_BY_EXPLAIN.agent_instruction}
          </p>
          <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
            {p.rules.map((r) => (
              <li key={r.id} data-testid="rule-pack-rule" className="flex flex-col gap-1 px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-fg">{r.title}</span>
                  <EnforcedByBadge value={r.enforcedBy as EnforcedBy} />
                </div>
                {r.body !== r.title && <p className="text-sm whitespace-pre-wrap text-muted">{r.body}</p>}
                {statusLine(r) && (
                  <p className="text-xs text-subtle" data-testid="rule-pack-status" data-status={r.status}>
                    {statusLine(r)}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <ErrorBox error={err} />
          {canManage && (
            <div className="flex flex-wrap gap-2">
              {!allIn && (
                <Button
                  variant="primary"
                  loading={install.isPending}
                  onClick={() =>
                    install.mutate(p.id, {
                      onSuccess: (r) =>
                        toast.success(
                          `${plural(r.added.length, 'rule', 'rules')} added to ${t.ledger}${
                            r.skipped.length ? `, ${r.skipped.length} already covered by your own rules` : ''
                          }`,
                        ),
                    })
                  }
                >
                  Install pack
                </Button>
              )}
              {p.installed && (
                <Button variant="danger-ghost" onClick={() => setConfirmRemove(true)}>
                  Remove pack
                </Button>
              )}
            </div>
          )}
          <ConfirmDialog
            open={confirmRemove}
            onOpenChange={setConfirmRemove}
            title={`Remove ${p.name}?`}
            description="Rules from this pack that nobody edited are retired. Rules you edited stay as your own."
            confirmLabel="Remove pack"
            pending={remove.isPending}
            onConfirm={() =>
              remove.mutate(p.id, {
                onSuccess: (r) => {
                  setConfirmRemove(false);
                  toast.success(
                    `${plural(r.retired.length, 'rule', 'rules')} retired, ${r.kept.length} kept as your own`,
                  );
                },
                onError: () => setConfirmRemove(false),
              })
            }
          />
        </>
      )}
    </div>
  );
}

function PackList({ onOpen }: { onOpen: (id: string) => void }) {
  const packs = useRulePacks();
  const groups = [
    { label: 'General', items: packs.data?.filter((p) => p.kind === 'general') ?? [] },
    { label: 'Industry', items: packs.data?.filter((p) => p.kind === 'industry') ?? [] },
  ];
  return (
    <div className="flex flex-col gap-4">
      {packs.isPending && <ListSkeleton label="Loading the packs" />}
      <ErrorBox error={packs.error} onRetry={() => packs.refetch()} />
      {groups
        .filter((g) => g.items.length > 0)
        .map((g) => (
          <section key={g.label} aria-label={g.label} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-subtle uppercase">{g.label}</h3>
            <ul className="flex flex-col gap-2">
              {g.items.map((p) => (
                <li key={p.id} data-testid="rule-pack">
                  <button
                    type="button"
                    onClick={() => onOpen(p.id)}
                    className="flex w-full flex-col gap-1 rounded-control border border-line px-3 py-3 text-left hover:bg-sunken [@media(pointer:coarse)]:min-h-11"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-fg">{p.name}</span>
                      {p.installed && <Badge tone="green">Installed</Badge>}
                      <span className="text-xs text-subtle">{plural(p.ruleCount, 'rule', 'rules')}</span>
                    </span>
                    <span className="text-sm text-muted">{p.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

/** Rule packs of a business organization: list, preview each rule with how it is held, install and remove. */
export function RulePacksDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useOrgTerms();
  const [packId, setPackId] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setPackId(null);
        onOpenChange(o);
      }}
      title="Rule packs"
      description={`Ready-made ${t.standingOrder} sets. Install one to add its rules to ${t.ledger}.`}
      size="lg"
    >
      <div className="overflow-y-auto">
        {packId ? (
          <PackPreview packId={packId} onBack={() => setPackId(null)} />
        ) : (
          <PackList onOpen={setPackId} />
        )}
      </div>
    </Dialog>
  );
}
