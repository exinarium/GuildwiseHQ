import { setupWorker } from 'msw/browser';
import type { LiveSocket } from '../ws/socket.ts';
import { db } from './db.ts';
import { handlers } from './handlers.ts';
import { simulateTurn } from './handlers-chat.ts';

/** Dev only (VITE_MSW=1). Sign in with admin@example.com / password123456. */
export async function startMocks(socket: LiveSocket): Promise<void> {
  db.socket = socket;
  socket.enableMockTransport();
  // The mock has no runner: a chat message plays a scripted turn (tool activity, then streamed text).
  socket.send = (m) => {
    if (m.type === 'chat.send') void simulateTurn(m.threadId, m.body, m.clientMsgId);
  };
  await setupWorker(...handlers).start({ onUnhandledFrame: 'bypass', quiet: true });
}
