import { MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useStartPersonaChat } from '../../api/queries/my-capabilities.ts';
import { Button, ErrorBox } from '../ui.tsx';

/** "Chat with persona": a one-to-one session with a persona that is not hired, on your own workstation. */
export function ChatWithPersona({ personaKey, name }: { personaKey: string; name: string }) {
  const start = useStartPersonaChat();
  const nav = useNavigate();
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        loading={start.isPending}
        data-testid={`chat-with-${personaKey}`}
        aria-label={`Chat with ${name}`}
        onClick={() =>
          start.mutate({ personaKey }, { onSuccess: (s) => nav(`/persona-chats/${s.threadId}`) })
        }
      >
        <MessageSquare aria-hidden="true" className="size-3.5" />
        Chat
      </Button>
      {start.isError && <ErrorBox error={start.error} />}
    </>
  );
}
