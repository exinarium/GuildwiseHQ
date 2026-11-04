import { powOk } from './pow.ts';

self.onmessage = (e: MessageEvent<{ session: string; bits: number }>) => {
  const { session, bits } = e.data;
  for (let i = 0; ; i++) {
    const nonce = i.toString(36);
    if (powOk(session, nonce, bits)) {
      (self as unknown as { postMessage(m: string): void }).postMessage(nonce);
      return;
    }
  }
};
