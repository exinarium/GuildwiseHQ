import { describe, expect, it } from 'vitest';
import { PUBLIC_FORM_ERROR_CODES } from '../src/forms/public.ts';
import { PROTOCOL_VERSION } from '../src/ids.ts';
import { CommandPayloadSchemas, StorageWriteOpenSchema } from '../src/protocol/runner.ts';
import {
  healthStateForError,
  STORAGE_ERROR_CODES,
  STORAGE_RETRYABLE,
  StorageWriteErrorSchema,
  storageError,
} from '../src/storage/index.ts';

describe('malware scan contract', () => {
  it('both codes exist for storage and for the public form', () => {
    for (const c of ['malware_detected', 'scan_unavailable'] as const) {
      expect(STORAGE_ERROR_CODES).toContain(c);
      expect(PUBLIC_FORM_ERROR_CODES).toContain(c);
    }
  });
  it('retryable is defined for every storage code; a scan failure can be retried, an infection cannot', () => {
    for (const c of STORAGE_ERROR_CODES) expect(typeof STORAGE_RETRYABLE[c]).toBe('boolean');
    expect(STORAGE_RETRYABLE.malware_detected).toBe(false);
    expect(STORAGE_RETRYABLE.scan_unavailable).toBe(true);
    expect(storageError('malware_detected', 'x').retryable).toBe(false);
    expect(StorageWriteErrorSchema.safeParse(storageError('scan_unavailable', 'x')).success).toBe(true);
  });
  it('neither code marks the connection unhealthy beyond "unavailable"', () => {
    expect(healthStateForError('malware_detected')).toBe('unavailable');
  });
  it('storage.write.open carries optional submission and scan context', () => {
    const base = {
      v: PROTOCOL_VERSION,
      id: 'm1',
      ts: new Date().toISOString(),
      type: 'storage.write.open',
      transferId: '5c9d1d0e-1b6e-4c0f-9a53-2c1f3e4a5b66',
      connectionId: '0b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11',
      folder: 'a',
      name: 'b',
      vars: {},
      contentType: 'text/plain',
      size: 1,
      deadlineMs: 1000,
    };
    expect(StorageWriteOpenSchema.safeParse(base).success).toBe(true);
    const id = 'aaaaaaaa-1b6e-4c0f-9a53-2c1f3e4a5b66';
    const withCtx = {
      ...base,
      submission: { orgId: id, formId: id, submissionId: id },
      scan: { field: 'f', fileName: 'a.pdf' },
    };
    expect(StorageWriteOpenSchema.parse(withCtx)).toMatchObject({ scan: { field: 'f' } });
  });
  it('storage.discard takes a submission id only', () => {
    const s = CommandPayloadSchemas['storage.discard'];
    expect(s.safeParse({ submissionId: 'aaaaaaaa-1b6e-4c0f-9a53-2c1f3e4a5b66' }).success).toBe(true);
    expect(s.safeParse({ submissionId: 'x' }).success).toBe(false);
  });
});
