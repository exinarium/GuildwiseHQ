import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RelayEvent, RelayHandler } from './dispatch.ts';

/** Where a relayed event goes on this workstation. */
export interface RelaySink {
  put(e: RelayEvent): Promise<void>;
}

/**
 * Writes each event as one JSON file, `<dir>/<integrationId>/<receivedAt>-<requestId>.json` (mode 0600, directory 0700,
 * written to a temporary name first and renamed, so a reader never sees half a file). The body is kept as base64: the
 * exact bytes.
 */
export class FileRelaySink implements RelaySink {
  constructor(private readonly dir: string) {}

  async put(e: RelayEvent): Promise<void> {
    const folder = join(this.dir, e.integrationId);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    const stamp = e.receivedAt.toISOString().replace(/[:.]/g, '-');
    const file = join(folder, `${stamp}-${e.requestId}.json`);
    const tmp = `${file}.tmp`;
    const record = {
      requestId: e.requestId,
      integrationId: e.integrationId,
      kind: e.kind,
      method: e.method,
      query: e.query,
      headers: e.headers,
      bodyBase64: e.body.toString('base64'),
      receivedAt: e.receivedAt.toISOString(),
    };
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }
}

/** The `generic` kind: hands the event to the local sink and answers 200. A sink failure throws, so the answer is a 500. */
export const genericHandler =
  (sink: RelaySink): RelayHandler =>
  async (e) => {
    await sink.put(e);
    return { status: 200 };
  };
