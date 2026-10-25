import { MAIL_SKIP_REASONS, type MailSkipReason } from '@aom/shared';
import { useInboundHealth } from '../../api/queries/mail.ts';
import { Badge, Callout, ErrorBox, ListSkeleton, PageHeader, Panel } from '../../components/ui.tsx';
import { formatDateTime } from '../../lib/time.ts';

const kb = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(0)} MB` : `${Math.round(n / 1000)} KB`;

/**
 * `/platform/inbound`: the inbound mail provider's status. The Postmark account, the receiving domain and the webhook
 * secret are set once by the platform owner (docs/SELF-HOSTING.md "Inbound e-mail"); this page shows whether they are in
 * place and what has been arriving, without any organisation's mail.
 */
export function PlatformInbound() {
  const health = useInboundHealth();
  return (
    <div>
      <PageHeader
        title="Inbound mail"
        sub="Mail that organisations receive at their own Guildwise addresses arrives through one provider webhook."
      />
      {health.isPending && <ListSkeleton label="Loading" rows={2} />}
      {health.isError && <ErrorBox error={health.error} onRetry={() => health.refetch()} />}
      {health.data && (
        <div className="flex max-w-3xl flex-col gap-4" data-testid="inbound-health">
          {!health.data.configured && (
            <Callout tone="warning" title="Inbound e-mail is not set up">
              {health.data.provider ? '' : 'AOM_INBOUND_PROVIDER is not set. '}
              {health.data.domain ? '' : 'AOM_INBOUND_DOMAIN is not set. '}
              {health.data.secretSet ? '' : 'AOM_INBOUND_SECRET is not set. '}
              Organisations cannot make inbox addresses until all three are. The steps are in
              docs/SELF-HOSTING.md, "Inbound e-mail".
            </Callout>
          )}
          <Panel title="Provider">
            <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
              <dt className="text-muted">Provider</dt>
              <dd data-testid="inbound-provider">
                {health.data.provider ?? 'none'}{' '}
                <Badge tone={health.data.configured ? 'success' : 'warning'}>
                  {health.data.configured ? 'Ready' : 'Not ready'}
                </Badge>
              </dd>
              <dt className="text-muted">Receiving domain</dt>
              <dd className="font-mono">{health.data.domain ?? 'not set'}</dd>
              <dt className="text-muted">Webhook secret</dt>
              <dd>{health.data.secretSet ? 'Set' : 'Not set'}</dd>
              <dt className="text-muted">Inboxes</dt>
              <dd>{health.data.inboxes}</dd>
              <dt className="text-muted">Last message</dt>
              <dd>{health.data.lastReceivedAt ? formatDateTime(health.data.lastReceivedAt) : 'none yet'}</dd>
              <dt className="text-muted">Limits</dt>
              <dd>
                {kb(health.data.limits.maxMessageBytes)} per message, {health.data.limits.ratePerHourPerOrg}{' '}
                per organisation per hour, spam from score {health.data.limits.spamThreshold}
              </dd>
            </dl>
          </Panel>
          <Panel title="Last 24 hours">
            <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm" data-testid="inbound-24h">
              <dt className="text-muted">Accepted</dt>
              <dd>{health.data.last24h.received}</dd>
              <dt className="text-muted">Skipped</dt>
              <dd>
                {health.data.last24h.skipped}
                {Object.entries(health.data.last24h.skippedByReason).length > 0 && (
                  <span className="text-muted">
                    {' '}
                    (
                    {Object.entries(health.data.last24h.skippedByReason)
                      .map(([r, n]) => `${n} ${MAIL_SKIP_REASONS[r as MailSkipReason]?.toLowerCase() ?? r}`)
                      .join(', ')}
                    )
                  </span>
                )}
              </dd>
              <dt className="text-muted">Unknown address</dt>
              <dd>{health.data.last24h.unknownAddress}</dd>
              <dt className="text-muted">Refused (bad credentials)</dt>
              <dd>
                {health.data.last24h.authFailed}
                {health.data.last24h.authFailed > 0 && (
                  <span className="text-muted"> - check the secret in the provider's webhook URL</span>
                )}
              </dd>
            </dl>
          </Panel>
        </div>
      )}
    </div>
  );
}
