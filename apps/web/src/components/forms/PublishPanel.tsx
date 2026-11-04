import type { FormPublicationDto, FormPublicationWarning } from '@aom/shared';
import { useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import { usePublicationAction } from '../../api/queries/public-forms.ts';
import { qrPng, qrSvg } from '../../lib/qr.ts';
import { copyText } from '../../lib/secure.ts';
import { QrCode } from '../security/QrCode.tsx';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { Button, Callout, useToast } from '../ui.tsx';

const WARNING_TEXT: Record<FormPublicationWarning, string> = {
  destination_missing:
    'A storage connection is missing or was removed. Choose one in the form settings and for each file field.',
  destination_offline:
    "The workstation that holds a storage connection is offline. Clients can't send the form until it is back.",
  unsupported_file_types:
    'A file field lists types public forms never accept (programs, macro documents, SVG). They are ignored.',
  connection_unhealthy: 'A storage connection needs attention (see Organization settings, Storage).',
};

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Publish, unpublish and the public address of a form, with its QR code. The QR code encodes exactly the shown URL. */
export function PublishPanel({
  formId,
  publication,
  canEdit,
}: {
  formId: string;
  publication: FormPublicationDto;
  canEdit: boolean;
}) {
  const act = usePublicationAction(formId);
  const toast = useToast();
  const [confirm, setConfirm] = useState<'unpublish' | 'reset' | null>(null);
  const published = publication.status === 'published';
  const url = published ? publication.url : null;
  const behind = published && publication.version !== null && publication.latestVersion > publication.version;

  const run = (a: 'publish' | 'unpublish' | 'reset') =>
    act.mutate(a, {
      onSuccess: () => {
        setConfirm(null);
        toast.success(
          a === 'publish' ? 'Published.' : a === 'unpublish' ? 'The form is closed.' : 'New link created.',
        );
      },
      onError: (e) => {
        setConfirm(null);
        toast.error(errorMessage(e));
      },
    });

  return (
    <section aria-label="Public link" data-testid="publish-panel" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid="publication-status"
          className={`rounded-control px-2 py-0.5 text-sm font-medium ${published ? 'bg-success-soft text-success-soft-fg' : 'bg-sunken text-muted'}`}
        >
          {publication.archived ? 'Archived' : published ? 'Published' : 'Not published'}
        </span>
        {published && publication.version !== null && (
          <span className="text-sm text-muted">Version {publication.version} is live.</span>
        )}
      </div>
      {publication.archived && (
        <Callout tone="info">This form is archived: the public link is closed.</Callout>
      )}
      {publication.warnings.map((w) => (
        <Callout key={w.code} tone="warning" data-testid={`warning-${w.code}`}>
          {WARNING_TEXT[w.code]}
        </Callout>
      ))}
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {(!published || behind) && !publication.archived && (
            <Button
              variant="primary"
              loading={act.isPending}
              onClick={() => run('publish')}
              data-testid="publish-form"
            >
              {published ? 'Publish changes' : 'Publish'}
            </Button>
          )}
          {published && (
            <>
              <Button
                variant="secondary"
                onClick={() => setConfirm('unpublish')}
                data-testid="unpublish-form"
              >
                Unpublish
              </Button>
              <Button variant="ghost" onClick={() => setConfirm('reset')} data-testid="reset-link">
                Create a new link
              </Button>
            </>
          )}
        </div>
      )}
      {url && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <QrCode value={url} label="QR code of the public form address" size={176} />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p
              className="break-all rounded-control border border-line bg-sunken px-3 py-2 text-base text-fg"
              data-testid="public-url"
            >
              {url}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                data-testid="copy-url"
                onClick={() =>
                  void copyText(url).then((ok) =>
                    ok ? toast.success('Copied.') : toast.error('Copy failed.'),
                  )
                }
              >
                Copy link
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => download(new Blob([qrSvg(url)], { type: 'image/svg+xml' }), 'form-qr.svg')}
              >
                Download SVG
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void qrPng(url).then((b) => download(b, 'form-qr.png'))}
              >
                Download PNG
              </Button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === 'reset' ? 'Create a new link?' : 'Unpublish this form?'}
        description={
          confirm === 'reset'
            ? 'The old address and every printed QR code stop working. Personal links move to the new address: copy them again.'
            : 'The address will show "form not available". Nobody can send the form until you publish it again.'
        }
        confirmLabel={confirm === 'reset' ? 'Create a new link' : 'Unpublish'}
        pending={act.isPending}
        onConfirm={() => confirm && run(confirm)}
      />
    </section>
  );
}
