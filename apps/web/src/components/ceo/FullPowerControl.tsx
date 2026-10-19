import { type LedgerEntryDto, OWNER_RESERVED_KEYS, OWNER_RESERVED_LABEL } from '@aom/shared';
import { useState } from 'react';
import { useAuthorizeOrder, useEscalateOrder, useRevokeOrderAuthority } from '../../api/queries/ledger.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { useActiveOrgRole } from '../../lib/orgRole.ts';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  ErrorBox,
  Segmented,
  TextArea,
  TextInput,
  useToast,
} from '../ui.tsx';

/** sha256(title + "\n" + body) as hex: the wording the Owner marks. Falls back to the server's hash where subtle crypto is missing. */
export async function wordingHash(title: string, body: string, fallback: string | null): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fallback ?? '';
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(`${title}\n${body}`));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * "Give the CEO full power" on a standing order (docs/design/ceo-front-door.md section 3.4, 14.4): the Owner marks one of
 * his own orders, pinned to this exact wording, with a scope and the owner-reserved matters it may touch. An Admin sees the
 * state and may ask the Owner to take the order over.
 */
export function FullPowerControl({ e }: { e: LedgerEntryDto }) {
  const role = useActiveOrgRole();
  const owner = role === 'owner';
  const fp = e.fullPower;
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const revoke = useRevokeOrderAuthority(e.id);
  const toast = useToast();
  if (e.scope !== 'standing_order' || e.retiredAt || !fp) return null;

  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="full-power-control" data-state={fp.state}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {fp.state === 'authorized' && fp.current && (
          <Badge tone="green" data-testid="fp-authorized">
            The CEO enforces this with full power
          </Badge>
        )}
        {fp.state === 'authorized' && !fp.current && (
          <Badge tone="amber" data-testid="fp-voided">
            Edited since: authorize again
          </Badge>
        )}
        {fp.state === 'voided' && (
          <Badge tone="amber" data-testid="fp-voided">
            Edited since: authorize again
          </Badge>
        )}
        {fp.state === 'revoked' && <Badge tone="neutral">Full power revoked</Badge>}
        {fp.state === 'authorized' && fp.current && owner && (
          <Button
            size="sm"
            variant="ghost"
            loading={revoke.isPending}
            onClick={() => revoke.mutate(undefined, { onSuccess: () => toast.success('Full power revoked') })}
          >
            Revoke
          </Button>
        )}
        {owner && fp.eligible && fp.state !== 'authorized' && (
          <Button size="sm" onClick={() => setOpen(true)} data-testid="fp-give">
            Give the CEO full power
          </Button>
        )}
        {owner && fp.eligible && fp.state === 'authorized' && !fp.current && (
          <Button size="sm" onClick={() => setOpen(true)} data-testid="fp-give">
            Authorize again
          </Button>
        )}
        {!fp.eligible && (
          <span className="text-xs text-subtle" data-testid="fp-ineligible">
            Not eligible for full power{fp.ineligibleReason ? `: ${fp.ineligibleReason}` : ''}
          </span>
        )}
        {!fp.eligible && !owner && !fp.escalated && (
          <Button size="sm" onClick={() => setAsking(true)} data-testid="fp-escalate">
            Ask the Owner to take it over
          </Button>
        )}
        {fp.escalated && !fp.eligible && (
          <span className="text-xs text-subtle">Asked the Owner to take it over.</span>
        )}
      </div>
      {fp.state === 'authorized' && fp.current && fp.covers.length > 0 && (
        <p className="text-xs text-subtle">
          May act on:{' '}
          {fp.covers.map((k) => (OWNER_RESERVED_LABEL as Record<string, string>)[k] ?? k).join('; ')}
        </p>
      )}
      <ErrorBox error={revoke.error} />
      {open && <AuthorizeDialog e={e} onClose={() => setOpen(false)} />}
      {asking && <EscalateDialog e={e} onClose={() => setAsking(false)} />}
    </div>
  );
}

function AuthorizeDialog({ e, onClose }: { e: LedgerEntryDto; onClose: () => void }) {
  const authorize = useAuthorizeOrder(e.id);
  const projects = useProjects();
  const toast = useToast();
  const [scope, setScope] = useState<'all' | 'projects'>('all');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [triggers, setTriggers] = useState('');
  const [covers, setCovers] = useState<string[]>([]);
  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const submit = async () => {
    const versionHash = await wordingHash(e.title, e.body, e.fullPower?.versionHash ?? null);
    const trig = triggers
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    authorize.mutate(
      {
        versionHash,
        scope: {
          projectIds: scope === 'all' ? null : projectIds,
          ...(trig.length ? { triggers: trig } : {}),
        },
        covers,
      },
      {
        onSuccess: () => {
          toast.success('The CEO may enforce this order with full power');
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Give the CEO full power for this order"
      description="When an event clearly falls under this order, the CEO may start a turn that works as you on your workstation, to carry out exactly this order. Every turn is audited and appears in your daily report."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-testid="fp-authorize"
            loading={authorize.isPending}
            disabled={scope === 'projects' && projectIds.length === 0}
            onClick={submit}
          >
            Authorize this wording
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Callout tone="info" role="note">
          Bound to this exact wording. If anyone edits the order, the authority is void until you authorize it
          again.
        </Callout>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg">Which projects</span>
          <Segmented
            label="Scope"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: 'All projects' },
              { value: 'projects', label: 'Only these' },
            ]}
          />
          {scope === 'projects' && (
            <ul className="flex flex-col gap-1">
              {(projects.data ?? []).map((p) => (
                <li key={p.id}>
                  <label className="flex min-h-9 items-center gap-2 text-sm text-fg">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={projectIds.includes(p.id)}
                      onChange={() => setProjectIds((l) => toggle(l, p.id))}
                    />
                    {p.name} ({p.key})
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <TextInput
          label="Only for these triggers (optional)"
          value={triggers}
          onChange={(ev) => setTriggers(ev.target.value)}
          placeholder="bug_flagged, signal:loop"
          hint="Separate with commas. Empty: any event the CEO judges to fall under the order."
        />
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium text-fg">
            It may also act on these matters you normally decide yourself
          </legend>
          {OWNER_RESERVED_KEYS.map((k) => (
            <label key={k} className="flex min-h-9 items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                className="size-4"
                checked={covers.includes(k)}
                onChange={() => setCovers((l) => toggle(l, k))}
                aria-label={OWNER_RESERVED_LABEL[k]}
              />
              {OWNER_RESERVED_LABEL[k]}
            </label>
          ))}
        </fieldset>
        <ErrorBox error={authorize.error} />
      </div>
    </Dialog>
  );
}

function EscalateDialog({ e, onClose }: { e: LedgerEntryDto; onClose: () => void }) {
  const escalate = useEscalateOrder(e.id);
  const toast = useToast();
  const [note, setNote] = useState('');
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Ask the Owner to take this order over"
      description="An order an Admin wrote never carries full power unless the Owner marks it as his own."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={escalate.isPending}
            data-testid="fp-escalate-send"
            onClick={() =>
              escalate.mutate(note.trim(), {
                onSuccess: () => {
                  toast.success('The Owner was asked');
                  onClose();
                },
              })
            }
          >
            Ask the Owner
          </Button>
        </>
      }
    >
      <TextArea label="Why (optional)" value={note} onChange={(ev) => setNote(ev.target.value)} />
      <ErrorBox error={escalate.error} />
    </Dialog>
  );
}
