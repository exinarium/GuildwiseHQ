import type { DeskItemDto } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../../api/client.ts';
import {
  useCancelOfflineRequest,
  useResendOfflineLink,
  useShowOfflineEmail,
} from '../../api/queries/forms-offline.ts';
import { useWaitAction } from '../../api/queries/journeys.ts';
import { Button, useToast } from '../ui.tsx';

type Data = {
  requestId?: string;
  formId?: string;
  formTitle?: string;
  clientReference?: string;
  recordName?: string;
  attemptedAt?: string;
  linkSentAt?: string;
  linkExpiresAt?: string;
  journeyName?: string;
  instanceId?: string;
  waitId?: string;
  stepId?: string;
};

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * The desk notice of a client who tried a form while the firm's runner was offline: who, when and which journey, and
 * the actions. The email address is never part of the item: "Show email" fetches it on request (audited, Owner or Admin).
 */
export function FormOfflineLinkBlock({ item }: { item: DeskItemDto }) {
  const toast = useToast();
  const data = (item.data ?? {}) as Data;
  const show = useShowOfflineEmail();
  const resend = useResendOfflineLink();
  const cancel = useCancelOfflineRequest();
  const act = useWaitAction();
  const [email, setEmail] = useState<string | null>(null);
  const fail = (e: unknown) => toast.error(errorMessage(e));
  const sent = item.subkind === 'form_offline_link';
  const id = data.requestId ?? '';
  const busy = show.isPending || resend.isPending || cancel.isPending || act.isPending;
  const rows: Array<[string, string | null]> = [
    [
      'Client',
      [data.clientReference, data.recordName].filter(Boolean).join(', ') || 'A visitor of the public form',
    ],
    ['Form', data.formTitle ?? null],
    ['Journey', data.journeyName ? `${data.journeyName}${data.stepId ? `, step ${data.stepId}` : ''}` : null],
    ['Tried at', when(data.attemptedAt)],
    ...(sent
      ? ([
          ['Link sent at', when(data.linkSentAt)],
          ['Link expires', when(data.linkExpiresAt)],
        ] as Array<[string, string]>)
      : []),
  ];
  return (
    <div className="mt-2 flex flex-col gap-3" data-testid="form-offline-desk-item">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-subtle">{k}</dt>
              <dd className="text-fg [overflow-wrap:anywhere]">{v}</dd>
            </div>
          ))}
      </dl>
      <p className="text-sm text-muted">
        {data.instanceId && (
          <Link
            to={`/journeys/instances/${data.instanceId}`}
            className="font-medium text-brand-text underline"
          >
            Open the journey
          </Link>
        )}
        {data.formId && (
          <>
            {data.instanceId ? ' · ' : ''}
            <Link to={`/forms/${data.formId}`} className="font-medium text-brand-text underline">
              Open the form
            </Link>
          </>
        )}
      </p>
      {email && (
        <p className="text-sm text-fg [overflow-wrap:anywhere]" data-testid="form-offline-email">
          Email address: {email}
        </p>
      )}
      {sent && (
        <div className="sticky-actions flex flex-wrap gap-2 max-md:[&>button]:flex-1">
          {data.waitId && (
            <Button
              disabled={busy}
              data-testid="form-offline-continue"
              onClick={() => {
                if (
                  window.confirm(
                    'No submission has arrived through the link yet. Continue the journey anyway? The secure link will stop working.',
                  )
                )
                  act.mutate({ waitId: data.waitId as string, action: 'continue' }, { onError: fail });
              }}
            >
              Continue journey
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={busy}
            data-testid="form-offline-show"
            onClick={() => show.mutate(id, { onSuccess: (r) => setEmail(r.email), onError: fail })}
          >
            Show email
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            data-testid="form-offline-resend"
            onClick={() =>
              resend.mutate(id, { onSuccess: () => toast.success('The link was sent again.'), onError: fail })
            }
          >
            Resend link
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            data-testid="form-offline-cancel"
            onClick={() => cancel.mutate(id, { onError: fail })}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
