import { MAIL_STATUS_LABELS, type MailInboxDto, type MailMessageDto, normaliseAllowEntry } from '@aom/shared';
import { Copy, Inbox, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import {
  useCreateMailInbox,
  useInboxMessages,
  useMailInboxes,
  usePatchMailInbox,
  useRotateMailInbox,
} from '../../api/queries/mail.ts';
import { formatDateTime } from '../../lib/time.ts';
import { HelpHint } from '../help/HelpHint.tsx';
import { MailThreadPanel } from '../MailThreadPanel.tsx';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  Panel,
  TextInput,
  useToast,
} from '../ui.tsx';

const STATUS_TONE: Record<string, 'success' | 'info' | 'warning' | 'neutral'> = {
  card_created: 'success',
  draft_created: 'info',
  comment_added: 'info',
  processed: 'success',
  received: 'neutral',
  skipped: 'warning',
};

/** What became of a message, in a few words ("Draft card WEB-12", "Skipped: looked like spam"). */
export function messageOutcome(m: MailMessageDto): string {
  const base = MAIL_STATUS_LABELS[m.status as keyof typeof MAIL_STATUS_LABELS] ?? m.status;
  if (m.status === 'skipped') return `${base}: ${m.reasonText ?? 'no reason recorded'}`;
  return m.cardRef ? `${base} ${m.cardRef}` : base;
}

/** The recent messages of one inbox: sender, subject, and what became of each. */
function Messages({ inboxId }: { inboxId: string }) {
  const list = useInboxMessages(inboxId);
  const [open, setOpen] = useState<MailMessageDto | null>(null);
  if (list.isPending) return <ListSkeleton label="Loading messages" rows={2} />;
  if (list.isError) return <ErrorBox error={list.error} onRetry={() => list.refetch()} />;
  if (list.data.length === 0)
    return (
      <p className="text-sm text-muted">Nothing has arrived yet. Send a test mail to the address above.</p>
    );
  return (
    <ul className="divide-y divide-line text-sm" data-testid="inbox-messages" aria-label="Recent messages">
      {list.data.map((m) => (
        <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
          <span className="min-w-[10rem] flex-1">
            <span className="block truncate font-medium text-fg">{m.subject}</span>
            <span className="block truncate text-xs text-subtle">
              {m.fromName ? `${m.fromName} <${m.from}>` : m.from} · {formatDateTime(m.receivedAt)}
              {m.attachments > 0
                ? ` · ${m.attachments} attachment${m.attachments === 1 ? '' : 's'} (not kept)`
                : ''}
            </span>
          </span>
          {m.allowListed && <Badge tone="brand">Allow-listed</Badge>}
          {m.auth === 'pass' && <Badge tone="success">Verified sender</Badge>}
          <Badge tone={STATUS_TONE[m.status] ?? 'neutral'} data-testid="message-status">
            {messageOutcome(m)}
          </Badge>
          {m.status !== 'skipped' && (
            <Button size="sm" onClick={() => setOpen(m)} data-testid="open-thread">
              Conversation
            </Button>
          )}
        </li>
      ))}
      <li className="list-none">
        <Dialog
          open={open !== null}
          onOpenChange={(o) => !o && setOpen(null)}
          title={open?.subject ?? 'Conversation'}
          description="The messages of this conversation and your replies to it."
          size="lg"
        >
          {open && <MailThreadPanel refTo={{ kind: 'thread', id: open.threadId }} />}
        </Dialog>
      </li>
    </ul>
  );
}

/** Who may have cards queued directly: full addresses and domains. Only the Owner changes it. */
function AllowList({ inbox, canEdit }: { inbox: MailInboxDto; canEdit: boolean }) {
  const patch = usePatchMailInbox();
  const [entry, setEntry] = useState('');
  const [error, setError] = useState('');
  const save = (allowList: string[]) => patch.mutate({ id: inbox.id, body: { allowList } });
  const add = () => {
    const n = normaliseAllowEntry(entry);
    if (!n) {
      setError('Enter an address (ana@acme.com) or a domain (acme.com)');
      return;
    }
    setError('');
    setEntry('');
    if (!inbox.allowList.includes(n)) save([...inbox.allowList, n]);
  };
  return (
    <section
      aria-label={`Allow-list of ${inbox.label}`}
      className="flex flex-col gap-2"
      data-testid="allow-list"
    >
      <h4 className="text-sm font-semibold text-fg">Senders whose cards go straight to the agents</h4>
      <p className="text-xs text-muted">
        Cards made from e-mail start as drafts. For a sender on this list, an automation that is set to
        "Queued for the agents" skips the draft step, but only when the sender's address could be verified.
        {canEdit ? '' : ' Only the Owner can change this list.'}
      </p>
      {inbox.allowList.length === 0 ? (
        <p className="text-sm text-muted">Nobody yet: every card from this inbox starts as a draft.</p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label="Allowed senders">
          {inbox.allowList.map((a) => (
            <li
              key={a}
              className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1 font-mono text-xs text-fg"
            >
              {a}
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Remove ${a}`}
                  className="rounded-full p-0.5 text-muted hover:text-fg"
                  onClick={() => save(inbox.allowList.filter((x) => x !== a))}
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <TextInput
            label="Add a sender or domain"
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            placeholder="ana@acme.com or acme.com"
            error={error}
            maxLength={254}
          />
          <Button type="submit" loading={patch.isPending} data-testid="allow-add">
            Add
          </Button>
        </form>
      )}
      <ErrorBox error={patch.error} />
    </section>
  );
}

function InboxCard({ inbox, isOwner }: { inbox: MailInboxDto; isOwner: boolean }) {
  const toast = useToast();
  const patch = usePatchMailInbox();
  const rotate = useRotateMailInbox();
  const [confirm, setConfirm] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inbox.address);
      toast.success('Address copied');
    } catch {
      toast.error('Could not copy: select the address and copy it');
    }
  };
  return (
    <Panel
      title={inbox.label}
      actions={
        <Badge tone={inbox.enabled ? 'success' : 'neutral'}>{inbox.enabled ? 'On' : 'Switched off'}</Badge>
      }
    >
      <div className="flex flex-col gap-4" data-testid="mail-inbox">
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded-control bg-sunken px-2 py-1 text-sm break-all" data-testid="inbox-address">
            {inbox.address}
          </code>
          <Button size="sm" onClick={copy} aria-label={`Copy the address of ${inbox.label}`}>
            <Copy aria-hidden="true" className="size-4" />
            Copy
          </Button>
          <Button size="sm" onClick={() => setConfirm(true)} data-testid="rotate-inbox">
            <RefreshCw aria-hidden="true" className="size-4" />
            New address
          </Button>
          <Button
            size="sm"
            loading={patch.isPending}
            onClick={() => patch.mutate({ id: inbox.id, body: { enabled: !inbox.enabled } })}
          >
            {inbox.enabled ? 'Switch off' : 'Switch on'}
          </Button>
        </div>
        <p className="text-sm text-muted">
          To use your own address (support@yourcompany.com), set that mailbox to forward every message to the
          address above. Anyone can write to it, so mail from strangers is read as information, never as
          instructions.{' '}
          <HelpHint
            article="automations-and-integrations#email-inbox"
            label="About forwarding mail to this inbox"
          >
            Your customers keep writing to your own address. Set that mailbox to forward to this one: in
            Gmail, Settings, Forwarding and POP/IMAP, Add a forwarding address; in Outlook, Settings, Mail,
            Forwarding; or use a forwarding rule or alias at your mail host. Replies go from your own mailbox
            as usual.
          </HelpHint>
        </p>
        <AllowList inbox={inbox} canEdit={isOwner} />
        <section aria-label={`Recent messages of ${inbox.label}`} className="flex flex-col gap-1">
          <h4 className="text-sm font-semibold text-fg">
            Recent messages{' '}
            <span className="text-xs font-normal text-subtle">
              ({inbox.last24h.received} handled, {inbox.last24h.skipped} skipped in the last 24 hours)
            </span>
          </h4>
          <Messages inboxId={inbox.id} />
        </section>
        <ErrorBox error={patch.error ?? rotate.error} />
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        tone="primary"
        title="Make a new address for this inbox?"
        description="The current address stops working at once. Mail sent to it is recorded as skipped and goes nowhere. Update any forwarding rule or contact that uses it."
        confirmLabel="Make a new address"
        pending={rotate.isPending}
        onConfirm={() =>
          rotate.mutate(inbox.id, {
            onSuccess: () => {
              setConfirm(false);
              toast.success('New address ready');
            },
          })
        }
      />
    </Panel>
  );
}

/** Organization > E-mail inbox: the addresses people write or forward to, who may skip the draft step, and what arrived. */
export function MailInboxTab({ orgRole }: { orgRole: 'owner' | 'admin' }) {
  const inboxes = useMailInboxes();
  const create = useCreateMailInbox();
  const [label, setLabel] = useState('Support');
  if (inboxes.isPending) return <ListSkeleton label="Loading inboxes" rows={2} />;
  if (inboxes.isError) return <ErrorBox error={inboxes.error} onRetry={() => inboxes.refetch()} />;
  const data = inboxes.data;
  return (
    <div className="flex flex-col gap-4" data-testid="mail-inbox-tab">
      {!data.configured && (
        <Callout tone="warning" title="E-mail inboxes are not switched on for this platform yet">
          Your platform administrator needs to connect the mail provider first. Until then mail sent to your
          address is not delivered.
        </Callout>
      )}
      {data.configured && data.inboxes.length === 0 && (
        <EmptyState
          icon={Inbox}
          title="No inbox yet"
          description="An inbox gets its own address. Automations can turn the mail that arrives there into draft cards, and replies to those mails are added to the card."
        />
      )}
      {data.inboxes.map((i) => (
        <InboxCard key={i.id} inbox={i} isOwner={orgRole === 'owner'} />
      ))}
      {data.configured && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim()) create.mutate({ label: label.trim() });
          }}
        >
          <TextInput
            label="Name of a new inbox"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={80}
          />
          <Button type="submit" variant="primary" loading={create.isPending} data-testid="create-inbox">
            Make an inbox
          </Button>
        </form>
      )}
      <ErrorBox error={create.error} />
    </div>
  );
}
