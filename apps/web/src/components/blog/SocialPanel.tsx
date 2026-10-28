import type { SocialChannel } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useConnectChannel, useDisconnectChannel } from '../../api/queries/blog.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Button, Callout, ErrorBox, Panel, TextInput, useToast } from '../ui.tsx';

const NAMES: Record<string, { name: string; idLabel: string; help: string }> = {
  facebook: {
    name: 'Facebook Page',
    idLabel: 'Page id',
    help: 'The Page access token of the Guildwise page (pages_manage_posts).',
  },
  linkedin: {
    name: 'LinkedIn organization',
    idLabel: 'Organization id',
    help: 'Organization id: the number only (for example 5515715), not urn:li:organization:5515715. The access token needs w_organization_social; add the refresh token so it can be renewed.',
  },
  x: {
    name: 'X account',
    idLabel: '',
    help: 'From a developer app with "Read and write" user authentication: the API key and secret, and the access token and secret of the account (OAuth 1.0a). They do not expire. X charges for API use, so keep credit on the account.',
  },
  youtube: {
    name: 'YouTube channel',
    idLabel: '',
    help: 'Uploads of approved videos (Videos tab). Paste a refresh token for the channel with the scope youtube.force-ssl, made with the OAuth client in AOM_YOUTUBE_CLIENT_ID and AOM_YOUTUBE_CLIENT_SECRET. It is checked with YouTube and stored encrypted. A client in Testing mode loses its tokens after 7 days: publish the OAuth app (In production) so they last.',
  },
  bluesky: {
    name: 'Bluesky account',
    idLabel: '',
    help: 'Your handle (for example guildwise.bsky.social) and an app password from Settings, App passwords. Never your main password.',
  },
};

/** Platform > Blog (Posts tab), Social sharing: connect the Facebook Page and the LinkedIn organization; status per network. */
export function SocialPanel({
  channels,
  failedShares,
  needReconnect,
}: {
  channels: SocialChannel[];
  failedShares: number;
  needReconnect: string[];
}) {
  return (
    <Panel title="Social sharing" data-testid="social-panel">
      <p className="mb-3 text-sm text-muted">
        Published articles are shared automatically to Facebook, LinkedIn, X and Bluesky. YouTube is only for
        the videos you approve. Tokens are stored encrypted and never shown again. Unpublishing an article
        does not delete what was shared.
      </p>
      {needReconnect.length > 0 && (
        <Callout
          tone="danger"
          title="Reconnect needed"
          role="alert"
          className="mb-3"
          data-testid="social-alert"
        >
          Sharing to {needReconnect.map((n) => NAMES[n]?.name ?? n).join(' and ')} is paused because the token
          was refused or has expired. Paste a fresh token below; waiting posts from the last 48 hours are then
          shared.
        </Callout>
      )}
      {failedShares > 0 && (
        <Callout tone="warning" className="mb-3" data-testid="social-failed">
          {failedShares} share{failedShares === 1 ? '' : 's'} failed for good. Open the article to see the
          reason and share it again.
        </Callout>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {channels.map((c) => (
          <Channel key={c.network} channel={c} />
        ))}
      </div>
    </Panel>
  );
}

function Channel({ channel }: { channel: SocialChannel }) {
  const meta = NAMES[channel.network] as { name: string; idLabel: string; help: string };
  const connect = useConnectChannel();
  const disconnect = useDisconnectChannel();
  const toast = useToast();
  const [open, setOpen] = useState(!channel.connected);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [refresh, setRefresh] = useState('');
  const [expires, setExpires] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [accessSecret, setAccessSecret] = useState('');
  const [handle, setHandle] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const body = () => {
    if (channel.network === 'x')
      return {
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim(),
        accessToken: token.trim(),
        accessSecret: accessSecret.trim(),
        accountName: name.trim(),
      };
    if (channel.network === 'youtube') return { refreshToken: refresh.trim() };
    if (channel.network === 'bluesky') return { handle: handle.trim(), appPassword: appPassword.trim() };
    return {
      accountId: id.trim(),
      accountName: name.trim(),
      accessToken: token.trim(),
      ...(refresh.trim() ? { refreshToken: refresh.trim() } : {}),
      expiresAt: expires ? new Date(`${expires}T00:00:00Z`).toISOString() : null,
    };
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    connect.mutate(
      { network: channel.network, ...body() },
      {
        onSuccess: () => {
          setToken('');
          setRefresh('');
          setApiKey('');
          setApiSecret('');
          setAccessSecret('');
          setAppPassword('');
          setOpen(false);
          toast.success(`${meta.name} connected`);
        },
      },
    );
  };
  return (
    <div className="rounded-card border border-line p-3" data-testid={`social-${channel.network}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-fg">{meta.name}</h3>
        {channel.status === 'ok' && <Badge tone="success">Connected</Badge>}
        {channel.status === 'needs_reconnect' && <Badge tone="danger">Needs reconnect</Badge>}
        {channel.status === 'disconnected' && <Badge tone="neutral">Not connected</Badge>}
      </div>
      {channel.connected && (
        <p className="mt-1 text-sm text-muted">
          {channel.accountName}
          {channel.expiresAt && <> · token expires {formatDateTime(channel.expiresAt)}</>}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {channel.connected && (
          <Button size="sm" onClick={() => setOpen((o) => !o)}>
            {open ? 'Cancel' : 'Replace the credentials'}
          </Button>
        )}
        {channel.connected && (
          <Button
            size="sm"
            variant="danger-ghost"
            loading={disconnect.isPending}
            onClick={() => disconnect.mutate(channel.network)}
          >
            Disconnect
          </Button>
        )}
      </div>
      {open && (
        <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
          <p className="text-xs text-subtle">{meta.help}</p>
          {channel.network === 'x' && (
            <>
              <TextInput
                label="API key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
              />
              <TextInput
                label="API secret"
                type="password"
                autoComplete="off"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                required
              />
              <TextInput
                label="Access token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
              />
              <TextInput
                label="Access token secret"
                type="password"
                autoComplete="off"
                value={accessSecret}
                onChange={(e) => setAccessSecret(e.target.value)}
                required
              />
              <TextInput label="Name (for you)" value={name} onChange={(e) => setName(e.target.value)} />
            </>
          )}
          {channel.network === 'bluesky' && (
            <>
              <TextInput
                label="Handle"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="guildwise.bsky.social"
                required
              />
              <TextInput
                label="App password"
                type="password"
                autoComplete="off"
                value={appPassword}
                onChange={(e) => setAppPassword(e.target.value)}
                required
              />
            </>
          )}
          {channel.network === 'youtube' && (
            <TextInput
              label="Refresh token"
              type="password"
              autoComplete="off"
              value={refresh}
              onChange={(e) => setRefresh(e.target.value)}
              required
            />
          )}
          {(channel.network === 'facebook' || channel.network === 'linkedin') && (
            <>
              <TextInput label={meta.idLabel} value={id} onChange={(e) => setId(e.target.value)} required />
              <TextInput label="Name (for you)" value={name} onChange={(e) => setName(e.target.value)} />
              <TextInput
                label="Access token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
              />
              {channel.network === 'linkedin' && (
                <TextInput
                  label="Refresh token"
                  type="password"
                  autoComplete="off"
                  value={refresh}
                  onChange={(e) => setRefresh(e.target.value)}
                />
              )}
              <TextInput
                label="Token expires on"
                type="date"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
                hint="You get an alert before it ends. Leave empty for a token that does not expire."
              />
            </>
          )}
          <div>
            <Button type="submit" variant="primary" loading={connect.isPending}>
              Connect
            </Button>
          </div>
          <ErrorBox error={connect.error} />
        </form>
      )}
    </div>
  );
}
