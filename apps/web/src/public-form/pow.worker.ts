import type { WorkerReply, WorkerRequest } from './form-worker.ts';
import { powOk } from './pow.ts';
import { sha256Chunks } from './sha256.ts';

const reply = (m: WorkerReply) => (self as unknown as { postMessage(m: WorkerReply): void }).postMessage(m);

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  try {
    const req = e.data;
    if (req.kind === 'file') {
      reply({ kind: 'file', hex: await sha256Chunks(req.file) });
      return;
    }
    const { session, bits } = req;
    for (let i = 0; ; i++) {
      const nonce = i.toString(36);
      if (powOk(session, nonce, bits)) {
        reply({ kind: 'pow', nonce });
        return;
      }
    }
  } catch {
    reply({ kind: 'error', code: 'unsupported' });
  }
};
