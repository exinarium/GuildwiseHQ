import type { BlockKind, PlatformBlockEntry } from '@aom/shared';
import { Ban } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import {
  useAddPlatformBlock,
  usePlatformBlocklist,
  useRemovePlatformBlock,
} from '../../api/queries/platform-blocklist.ts';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  Select,
  TextInput,
  useToast,
} from '../ui.tsx';

const KINDS: Array<{ kind: BlockKind; label: string; placeholder: string; hint: string }> = [
  {
    kind: 'domain',
    label: 'Blocked domain',
    placeholder: 'spam.example',
    hint: 'Its subdomains are blocked too.',
  },
  {
    kind: 'email',
    label: 'Blocked address',
    placeholder: 'someone@example.com',
    hint: 'This exact address.',
  },
  {
    kind: 'ip',
    label: 'Blocked IP or range',
    placeholder: '203.0.113.7 or 203.0.113.0/24',
    hint: 'An IPv4 or IPv6 address, or a CIDR range.',
  },
  {
    kind: 'allow_domain',
    label: 'Allowed domain',
    placeholder: 'partner.example',
    hint: 'Skips the hosting provider’s checks (for example the throwaway-address list). Blocks above still apply.',
  },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.kind, k])) as Record<BlockKind, (typeof KINDS)[number]>;
const tone = { domain: 'danger', email: 'danger', ip: 'warning', allow_domain: 'success' } as const;

/**
 * The owner's block list (R1): addresses, domains and IPs refused at sign-up, invitations, sign-in and password reset,
 * and domains allowed past the hosted checks. Adding and removing ask to confirm it's you; every super admin is mailed.
 */
export function BlockListPanel() {
  const list = usePlatformBlocklist();
  const add = useAddPlatformBlock();
  const remove = useRemovePlatformBlock();
  const toast = useToast();
  const [kind, setKind] = useState<BlockKind>('domain');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [removing, setRemoving] = useState<PlatformBlockEntry | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    add.mutate(
      { kind, value: value.trim(), ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: () => {
          toast.success(`${KIND[kind].label} added`);
          setValue('');
          setNote('');
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-4" data-testid="blocklist-panel">
      <form
        onSubmit={submit}
        className="grid gap-3 rounded-card border border-line bg-surface p-4 sm:grid-cols-[12rem_1fr_1fr_auto] sm:items-end"
        data-testid="blocklist-form"
      >
        <Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value as BlockKind)}>
          {KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </Select>
        <TextInput
          label="Value"
          value={value}
          placeholder={KIND[kind].placeholder}
          hint={KIND[kind].hint}
          onChange={(e) => setValue(e.target.value)}
          maxLength={320}
          required
        />
        <TextInput
          label="Note (optional)"
          value={note}
          placeholder="Why it is on the list"
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
        />
        <Button type="submit" variant="primary" disabled={add.isPending || !value.trim()}>
          Add
        </Button>
        <div className="sm:col-span-4 empty:hidden">
          <ErrorBox error={add.error} />
        </div>
      </form>

      {list.isLoading ? (
        <ListSkeleton />
      ) : list.error ? (
        <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data?.length ? (
        <EmptyState
          icon={Ban}
          title="The block list is empty"
          description="Add a domain, an address or an IP to refuse it at sign-up, invitations, sign-in and password reset."
        />
      ) : (
        <ul
          className="divide-y divide-line rounded-card border border-line bg-surface"
          data-testid="blocklist-entries"
        >
          {list.data.map((b) => (
            <li
              key={b.id}
              className="flex flex-wrap items-center gap-3 px-4 py-3"
              data-testid="blocklist-entry"
            >
              <Badge tone={tone[b.kind]}>{KIND[b.kind].label}</Badge>
              <code className="min-w-0 flex-1 font-mono text-sm break-all text-fg">{b.value}</code>
              <div className="min-w-[10rem] flex-1 text-xs text-muted">
                {b.note && <div className="text-fg">{b.note}</div>}
                <div>
                  Added {new Date(b.createdAt).toLocaleString()}
                  {b.createdBy ? ` by ${b.createdBy.displayName}` : ''}
                </div>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setRemoving(b)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="empty:hidden">
        <ErrorBox error={remove.error} />
      </div>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.value ?? ''} from the list?`}
        description={
          removing?.kind === 'allow_domain'
            ? 'The hosting provider’s checks apply to this domain again.'
            : 'It is accepted again at sign-up, invitations, sign-in and password reset.'
        }
        confirmLabel="Remove"
        pending={remove.isPending}
        onConfirm={() =>
          removing &&
          remove.mutate(removing.id, {
            onSuccess: () => {
              toast.success(`${removing.value} removed`);
              setRemoving(null);
            },
            onError: () => setRemoving(null),
          })
        }
      />
    </div>
  );
}
