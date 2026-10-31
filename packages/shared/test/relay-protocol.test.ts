import { describe, expect, it } from 'vitest';
import {
  isAckedFromRunner,
  isAckedFromServer,
  makeEnvelope,
  RELAY_BODY_HARD_MAX_BYTES,
  RELAY_RESPONSE_MAX_BYTES,
  RelayIntegrationCreateSchema,
  RunnerToServerSchema,
  ServerToRunnerSchema,
} from '../src/index.ts';

const id = '0198f2a0-0000-7000-8000-000000000001';
const wire = (e: unknown) => JSON.parse(JSON.stringify(e));

describe('relay frames', () => {
  it('relay.serve round-trips', () => {
    const e = makeEnvelope('relay.serve', { integrations: [{ integrationId: id, kind: 'generic' }] });
    expect(RunnerToServerSchema.parse(wire(e))).toMatchObject({ type: 'relay.serve' });
  });

  it('relay.serve.result round-trips', () => {
    const e = makeEnvelope('relay.serve.result', {
      accepted: [id],
      refused: [{ integrationId: id, reason: 'not_allowed' }],
    });
    expect(ServerToRunnerSchema.parse(wire(e))).toMatchObject({ type: 'relay.serve.result' });
  });

  it('relay.request carries the raw bytes as base64', () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x7b]);
    const e = makeEnvelope('relay.request', {
      requestId: id,
      integrationId: id,
      kind: 'whatsapp_cloud',
      method: 'POST',
      query: 'hub.mode=subscribe&hub.challenge=1',
      headers: [
        ['x-hub-signature-256', 'sha256=abc'],
        ['x-dup', 'a'],
        ['x-dup', 'b'],
      ],
      body: raw.toString('base64'),
      deadlineMs: 4750,
    });
    const back = ServerToRunnerSchema.parse(wire(e));
    if (back.type !== 'relay.request') throw new Error('type');
    expect(Buffer.from(back.body, 'base64').equals(raw)).toBe(true);
    expect(back.headers).toHaveLength(3);
  });

  it('relay.request refuses a body over the hard cap', () => {
    const big = Buffer.alloc(RELAY_BODY_HARD_MAX_BYTES + 3).toString('base64');
    const e = makeEnvelope('relay.request', {
      requestId: id,
      integrationId: id,
      kind: 'generic',
      method: 'POST',
      query: '',
      headers: [],
      body: big,
      deadlineMs: 1000,
    });
    expect(ServerToRunnerSchema.safeParse(wire(e)).success).toBe(false);
  });

  it('relay.response round-trips and caps the body at 64 KiB', () => {
    const ok = makeEnvelope('relay.response', {
      requestId: id,
      status: 202,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('123').toString('base64'),
    });
    expect(RunnerToServerSchema.parse(wire(ok))).toMatchObject({ type: 'relay.response', status: 202 });
    const big = makeEnvelope('relay.response', {
      requestId: id,
      status: 200,
      body: Buffer.alloc(RELAY_RESPONSE_MAX_BYTES + 3).toString('base64'),
    });
    expect(RunnerToServerSchema.safeParse(wire(big)).success).toBe(false);
  });

  it('relay.response refuses a status outside 200..599', () => {
    const e = makeEnvelope('relay.response', { requestId: id, status: 100 });
    expect(RunnerToServerSchema.safeParse(wire(e)).success).toBe(false);
  });

  it('none of the relay frames is acked', () => {
    for (const t of ['relay.serve', 'relay.response']) expect(isAckedFromRunner(t)).toBe(false);
    for (const t of ['relay.serve.result', 'relay.request']) expect(isAckedFromServer(t)).toBe(false);
  });
});

describe('RelayIntegrationCreateSchema', () => {
  it('accepts kind and label', () => {
    expect(RelayIntegrationCreateSchema.safeParse({ kind: 'whatsapp_cloud', label: 'Shop' }).success).toBe(
      true,
    );
  });
  it('rejects a provider secret in the body', () => {
    expect(
      RelayIntegrationCreateSchema.safeParse({ kind: 'whatsapp_cloud', label: 'Shop', appSecret: 'x' })
        .success,
    ).toBe(false);
  });
  it('rejects an unknown kind', () => {
    expect(RelayIntegrationCreateSchema.safeParse({ kind: 'sms', label: 'x' }).success).toBe(false);
  });
});
