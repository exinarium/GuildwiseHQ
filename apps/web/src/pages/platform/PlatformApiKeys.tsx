import { BLOG_API_SCOPES, type BlogApiScope } from '@aom/shared';
import { KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useApiKeyAudit, useApiKeys, useCreateApiKey, useRevokeApiKey } from '../../api/queries/blog.ts';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog.tsx';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Panel,
  TextInput,
  useToast,
} from '../../components/ui.tsx';
import { formatDateTime } from '../../lib/time.ts';

const SCOPE_HELP: Record<BlogApiScope, string> = {
  'blog:read': 'List and read posts',
  'blog:write': 'Submit and revise its own posts (includes reading)',
  'blog:publish': 'Publish its own posts once the review period is over',
  'social:write': 'Ask for a social share and read share status',
};

/** `/platform/api-keys`: the Bearer keys of the writer agents. A key is shown once, at creation. */
export function PlatformApiKeys() {
  const keys = useApiKeys();
  const audit = useApiKeyAudit();
  const create = useCreateApiKey();
  const revoke = useRevokeApiKey();
  const toast = useToast();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<BlogApiScope[]>(['blog:write']);
  const [expires, setExpires] = useState('');
  const [ips, setIps] = useState('');
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      {
        name: name.trim(),
        scopes,
        expiresAt: expires ? new Date(`${expires}T23:59:59Z`).toISOString() : null,
        ipAllowList: ips
          .split(/[\s,]+/)
          .map((x) => x.trim())
          .filter(Boolean),
      },
      {
        onSuccess: (k) => {
          setSecret({ name: k.name, secret: k.secret });
          setName('');
          setIps('');
          setExpires('');
        },
      },
    );
  };

  return (
    <div>
      <PageHeader
        title="API keys"
        sub="Keys for the agent API (/api/v1). A key is stored hashed and shown once. See BLOG-API.md for the calls."
      />
      <Panel title="New key" className="mb-5">
        <form onSubmit={submit} className="flex flex-col gap-3" data-testid="key-form">
          <TextInput
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Blog writer agent"
            required
            data-testid="key-name"
          />
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-fg">Scopes</legend>
            <div className="flex flex-col gap-1">
              {BLOG_API_SCOPES.map((s) => (
                <label key={s} className="flex items-start gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={scopes.includes(s)}
                    onChange={(e) =>
                      setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))
                    }
                    data-testid={`scope-${s}`}
                  />
                  <span>
                    <code className="font-mono">{s}</code> <span className="text-muted">{SCOPE_HELP[s]}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextInput
              label="Expires on (optional)"
              type="date"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
            <TextInput
              label="Allowed addresses (optional)"
              value={ips}
              onChange={(e) => setIps(e.target.value)}
              placeholder="203.0.113.7, 198.51.100.2"
              hint="Only these IP addresses may use the key. Empty: any."
            />
          </div>
          <div>
            <Button
              type="submit"
              variant="primary"
              loading={create.isPending}
              disabled={!name.trim() || scopes.length === 0}
              data-testid="key-create"
            >
              Create key
            </Button>
          </div>
          <ErrorBox error={create.error} />
        </form>
      </Panel>

      {keys.isPending && <ListSkeleton label="Loading keys" rows={2} />}
      {keys.isError && <ErrorBox error={keys.error} onRetry={() => keys.refetch()} />}
      {keys.data?.length === 0 && (
        <EmptyState
          icon={KeyRound}
          title="No keys yet"
          description="Create a key to let an agent post to the blog."
        />
      )}
      {keys.data && keys.data.length > 0 && (
        <Panel padding="none" className="mb-5">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="keys-table">
              <thead className="text-left text-xs text-subtle">
                <tr>
                  <th className="px-4 py-2 font-medium">Key</th>
                  <th className="px-4 py-2 font-medium">Scopes</th>
                  <th className="px-4 py-2 font-medium">Last used</th>
                  <th className="px-4 py-2 font-medium">Last 24 h</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {keys.data.map((k) => {
                  const state = k.revokedAt
                    ? 'Revoked'
                    : k.expiresAt && new Date(k.expiresAt) <= new Date()
                      ? 'Expired'
                      : 'Active';
                  return (
                    <tr key={k.id} data-testid={`key-row-${k.id}`}>
                      <td className="px-4 py-2.5">
                        <span className="font-medium text-fg">{k.name}</span>
                        <span className="block font-mono text-xs text-subtle">{k.prefix}…</span>
                        <span className="block text-xs text-subtle">
                          Created {formatDateTime(k.createdAt)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {k.scopes.map((s) => (
                            <Badge key={s} tone="neutral">
                              {s}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-muted">
                        {k.lastUsedAt ? formatDateTime(k.lastUsedAt) : 'Never'}
                        {k.lastIp && <span className="block text-xs">{k.lastIp}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-muted">
                        {k.requests24h} requests, {k.posts24h} posts
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={state === 'Active' ? 'success' : 'danger'}>{state}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {state === 'Active' && (
                          <Button
                            size="sm"
                            variant="danger-ghost"
                            onClick={() => setRevoking({ id: k.id, name: k.name })}
                          >
                            Revoke
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel title="Recent requests">
        {audit.data?.length === 0 && <p className="text-sm text-muted">No API requests yet.</p>}
        {audit.data && audit.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="key-audit">
              <tbody className="divide-y divide-line">
                {audit.data.slice(0, 30).map((r) => (
                  <tr key={`${r.at}-${r.keyId}-${r.path}-${r.method}`}>
                    <td className="py-1.5 text-muted">{formatDateTime(r.at)}</td>
                    <td className="py-1.5">{r.keyName}</td>
                    <td className="py-1.5 font-mono text-xs">
                      {r.method} {r.path}
                    </td>
                    <td className="py-1.5">
                      <Badge tone={r.status < 300 ? 'success' : 'danger'}>{r.status}</Badge>
                    </td>
                    <td className="py-1.5 text-muted">{r.ip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Dialog
        open={!!secret}
        onOpenChange={(o) => !o && setSecret(null)}
        title="Copy the key now"
        description="This is the only time the key is shown."
        dismissible={false}
        footer={
          <Button variant="primary" onClick={() => setSecret(null)} data-testid="key-done">
            I have copied it
          </Button>
        }
      >
        <Callout tone="warning" className="mb-3">
          Store it in the environment of the writer agent. It cannot be shown again; if it is lost, revoke it
          and create another.
        </Callout>
        <p className="mb-1 text-sm font-medium text-fg">{secret?.name}</p>
        <code
          className="block rounded-control bg-sunken p-3 font-mono text-sm break-all text-fg"
          data-testid="key-secret"
        >
          {secret?.secret}
        </code>
        <div className="mt-2">
          <Button
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(secret?.secret ?? '');
              toast.success('Copied');
            }}
          >
            Copy
          </Button>
        </div>
      </Dialog>
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? 'this key'}?`}
        description="It stops working on the next request. This cannot be undone."
        confirmLabel="Revoke"
        pending={revoke.isPending}
        onConfirm={() =>
          revoking &&
          revoke.mutate(revoking.id, {
            onSuccess: () => {
              setRevoking(null);
              toast.success('Key revoked');
            },
          })
        }
      />
    </div>
  );
}
