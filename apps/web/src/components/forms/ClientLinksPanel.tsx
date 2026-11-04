import type { ClientLinkDto, ClientLinkState } from '@aom/shared';
import { useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import {
  useClientLinks,
  useCreateClientLink,
  useRevokeClientLink,
} from '../../api/queries/public-forms.ts';
import { copyText } from '../../lib/secure.ts';
import { QrCode } from '../security/QrCode.tsx';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { Button, Dialog, ErrorBox, Field, inputCls, Spinner, useToast } from '../ui.tsx';

const STATE_TEXT: Record<ClientLinkState, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
  used: 'Used',
};
const DAYS = [7, 14, 30, 90];

/** Personal links: one client or record each, signed, expiring and revocable. The link holds no personal data. */
export function ClientLinksPanel({ formId, canEdit, published }: { formId: string; canEdit: boolean; published: boolean }) {
  const links = useClientLinks(formId);
  const create = useCreateClientLink(formId);
  const revoke = useRevokeClientLink(formId);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reference, setReference] = useState('');
  const [days, setDays] = useState(14);
  const [revoking, setRevoking] = useState<ClientLinkDto | null>(null);
  const [qr, setQr] = useState<ClientLinkDto | null>(null);

  const submit = () =>
    create.mutate(
      { reference: reference.trim(), expiresInDays: days },
      {
        onSuccess: () => {
          setOpen(false);
          setReference('');
          toast.success('Personal link created.');
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <section aria-label="Personal links" data-testid="client-links" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold text-fg">Personal links</h3>
        {canEdit && (
          <Button variant="secondary" disabled={!published} onClick={() => setOpen(true)} data-testid="new-client-link">
            New personal link
          </Button>
        )}
      </div>
      {!published && <p className="text-sm text-muted">Publish the form to create personal links.</p>}
      {links.isPending && <Spinner />}
      {links.error && <ErrorBox error={links.error} />}
      <ul className="flex flex-col gap-2">
        {links.data?.map((l) => (
          <li
            key={l.id}
            className="flex flex-col gap-2 rounded-control border border-line p-3 sm:flex-row sm:items-center"
            data-testid={`client-link-${l.state}`}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-medium text-fg">{l.reference}</p>
              <p className="text-sm text-muted">
                {STATE_TEXT[l.state]} · expires {new Date(l.expiresAt).toLocaleDateString()}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {l.url && l.state === 'active' && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void copyText(l.url as string).then((ok) =>
                        ok ? toast.success('Copied.') : toast.error('Copy failed.'),
                      )
                    }
                  >
                    Copy
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setQr(l)}>
                    QR code
                  </Button>
                </>
              )}
              {canEdit && l.state === 'active' && (
                <Button size="sm" variant="ghost" onClick={() => setRevoking(l)}>
                  Revoke
                </Button>
              )}
            </div>
          </li>
        ))}
        {links.data?.length === 0 && <li className="text-sm text-muted">No personal links yet.</li>}
      </ul>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="New personal link"
        description="Use a client number or file reference, not a name. It stays on this server and is not part of the link."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={create.isPending} disabled={!reference.trim()} onClick={submit}>
              Create link
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Client or record reference" htmlFor="link-ref">
            <input
              id="link-ref"
              className={inputCls}
              value={reference}
              maxLength={120}
              onChange={(e) => setReference(e.target.value)}
              data-testid="link-reference"
            />
          </Field>
          <Field label="Expires after" htmlFor="link-days">
            <select
              id="link-days"
              className={inputCls}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Dialog>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke this link?"
        description="The client will see that the link is no longer valid."
        confirmLabel="Revoke"
        pending={revoke.isPending}
        onConfirm={() =>
          revoking &&
          revoke.mutate(revoking.id, {
            onSuccess: () => {
              setRevoking(null);
              toast.success('Link revoked.');
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
      <Dialog open={qr !== null} onOpenChange={(o) => !o && setQr(null)} title={`QR code for ${qr?.reference ?? ''}`}>
        {qr?.url && (
          <div className="flex justify-center">
            <QrCode value={qr.url} label="QR code of the personal link" size={220} />
          </div>
        )}
      </Dialog>
    </section>
  );
}
