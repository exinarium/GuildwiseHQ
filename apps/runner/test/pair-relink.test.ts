import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pairWithServer, RelinkRefusedError } from '../src/pair-request.ts';
import { addPairing, entryDir, loadIndex } from '../src/pairings.ts';
import { runnerPaths } from '../src/paths.ts';
import { FakeServer } from './fake-server.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/** UAT 1.10.0 finding 5, runner side: a re-run proves the current workstation and keeps it (and its local state). */
const OLD = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const NEW = '019e3f6a-7b1c-7a2d-8c3e-0123456789b1';
const body = { code: 'ABCD-EFGH', name: 'Desk', platform: 'linux', hostname: 'h', runnerVersion: 't' };

function pairedRoot(server: FakeServer) {
  const root = tmp('aom-root-');
  const r = addPairing(root, {
    serverUrl: server.url,
    label: 'Desk',
    workstationId: OLD,
    runnerToken: 'aomr_old',
  });
  // local state of the workstation: a queued report in the outbox
  const outbox = runnerPaths(entryDir(root, r.entry)).outbox;
  mkdirSync(outbox, { recursive: true });
  writeFileSync(join(outbox, 'x.json'), '{}');
  return { root, outbox };
}

describe('re-running pair on a paired machine', () => {
  it('proves the current workstation; a re-link keeps the same pairing and its local state', async () => {
    const server = await FakeServer.start({
      pairResponse: (req) => ({
        status: 200,
        body: { workstationId: req.previous?.workstationId, runnerToken: 'aomr_fresh', relinked: true },
      }),
    });
    try {
      const { root, outbox } = pairedRoot(server);
      const out = await pairWithServer({ root, server: server.url, code: body.code, name: 'Desk', body });
      expect(server.pairRequests[0]?.previous).toEqual({ workstationId: OLD, runnerToken: 'aomr_old' });
      expect(server.pairRequests[0]?.newWorkstation).toBeUndefined();
      expect(out.paired.relinked).toBe(true);
      const index = loadIndex(root);
      expect(index.pairings).toHaveLength(1);
      expect(index.pairings[0]?.workstationId).toBe(OLD);
      expect(existsSync(join(outbox, 'x.json'))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('a refused re-link changes nothing here; only the explicit yes pairs as a new workstation', async () => {
    const server = await FakeServer.start({
      pairResponse: (req) =>
        req.newWorkstation
          ? { status: 200, body: { workstationId: NEW, runnerToken: 'aomr_new' } }
          : {
              status: 409,
              body: {
                error: {
                  code: 'relink_refused',
                  message: 'This link belongs to a different account',
                  details: { reason: 'other_account', workstationName: 'Desk' },
                },
              },
            },
    });
    try {
      const { root, outbox } = pairedRoot(server);
      const refused = await pairWithServer({
        root,
        server: server.url,
        code: body.code,
        name: 'Desk',
        body,
      }).catch((e) => e);
      expect(refused).toBeInstanceOf(RelinkRefusedError);
      expect(refused.reason).toBe('other_account');
      expect(loadIndex(root).pairings[0]?.workstationId).toBe(OLD);
      expect(existsSync(join(outbox, 'x.json'))).toBe(true);
      const out = await pairWithServer({
        root,
        server: server.url,
        code: body.code,
        name: 'Desk',
        body,
        newWorkstation: true,
      });
      expect(server.pairRequests[1]?.newWorkstation).toBe(true);
      expect(out.paired.workstationId).toBe(NEW);
      expect(loadIndex(root).pairings[0]?.workstationId).toBe(NEW);
    } finally {
      await server.close();
    }
  });

  it('a first pairing with a server sends no proof', async () => {
    const server = await FakeServer.start();
    try {
      const root = tmp('aom-root-');
      await pairWithServer({ root, server: server.url, code: body.code, name: 'Desk', body });
      expect(server.pairRequests[0]?.previous).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
