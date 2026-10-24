import { MessageSquare } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMe } from '../../api/queries/auth.ts';
import { useStartPersonaChat } from '../../api/queries/my-capabilities.ts';
import { useWorkstations } from '../../api/queries/workstations.ts';
import { ModelSelect, unionExtras, unionProviders } from '../ModelSelect.tsx';
import { Button, Dialog, ErrorBox } from '../ui.tsx';

/**
 * "Chat with persona": a one-to-one session with a persona that is not hired, on your own workstation. It talks on the persona's
 * model unless you choose another here.
 */
export function ChatWithPersona({ personaKey, name }: { personaKey: string; name: string }) {
  const start = useStartPersonaChat();
  const nav = useNavigate();
  const me = useMe();
  const stations = useWorkstations({ enabled: true });
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState('');
  const mine = (stations.data ?? []).filter((w) => w.userId === me.data?.user.id && w.status === 'active');
  const go = () => {
    const [runtime, ...rest] = model.split('/');
    start.mutate(
      { personaKey, ...(model && runtime && rest.length ? { runtime, model: rest.join('/') } : {}) },
      { onSuccess: (s) => nav(`/persona-chats/${s.threadId}`) },
    );
  };
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        data-testid={`chat-with-${personaKey}`}
        aria-label={`Chat with ${name}`}
        onClick={() => setOpen(true)}
      >
        <MessageSquare aria-hidden="true" className="size-3.5" />
        Chat
      </Button>
      {open && (
        <Dialog
          open
          onOpenChange={(o) => !o && setOpen(false)}
          title={`Chat with ${name}`}
          description="A one-to-one chat on your own workstation. The persona can read skills and search the ledger and does nothing else; what it costs is tracked."
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={start.isPending}
                onClick={go}
                data-testid="start-persona-chat"
              >
                Start the chat
              </Button>
            </>
          }
        >
          <ModelSelect
            label="Model"
            value={model}
            onChange={setModel}
            runtimes={mine.flatMap((w) => w.runtimes.filter((r) => r.available).map((r) => r.id))}
            providers={unionProviders(mine)}
            extras={unionExtras(mine)}
            defaultLabel="The persona's own model"
          />
          <ErrorBox error={start.error} />
        </Dialog>
      )}
    </>
  );
}
