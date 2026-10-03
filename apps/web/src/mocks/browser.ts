import { setupWorker } from 'msw/browser';
import type { LiveSocket } from '../ws/socket.ts';
import { db } from './db.ts';
import { handlers } from './handlers.ts';

/** Dev only (VITE_MSW=1). Sign in with admin@example.com / password123456. */
export async function startMocks(socket: LiveSocket): Promise<void> {
  db.socket = socket;
  socket.enableMockTransport();
  await setupWorker(...handlers).start({ onUnhandledFrame: 'bypass', quiet: true });
}
