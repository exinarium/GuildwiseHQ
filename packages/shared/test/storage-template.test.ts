import { describe, expect, it } from 'vitest';
import {
  checkStorageTemplate,
  ENVELOPE_COMMANDS,
  healthStateForError,
  isAckedFromRunner,
  makeEnvelope,
  RunnerToServerSchema,
  renderStoragePath,
  ServerToRunnerSchema,
  sanitizeStorageSegment,
  storageClashName,
  storageError,
} from '../src/index.ts';

const vars = { journey: 'Rental', client: 'A. Smith', field: 'id-document', date: '2026-11-03', ext: 'pdf' };

describe('renderStoragePath', () => {
  it('fills folder and name templates', () => {
    const r = renderStoragePath({ folder: '{journey}/{client}', name: '{field}-{date}' }, vars);
    expect(r).toEqual({ ok: true, folder: ['Rental', 'A. Smith'], name: 'id-document-2026-11-03.pdf' });
  });
  it('keeps an extension that is already there', () => {
    const r = renderStoragePath({ folder: '', name: 'scan.png' }, vars, 'pdf');
    expect(r).toMatchObject({ ok: true, name: 'scan.png' });
  });
  it('refuses an unknown placeholder and a missing value', () => {
    expect(renderStoragePath({ folder: '{nope}', name: 'x' }, vars)).toMatchObject({ ok: false });
    expect(renderStoragePath({ folder: '{submission}', name: 'x' }, vars)).toMatchObject({ ok: false });
  });
  it('turns braces escaped by doubling into literal braces', () => {
    const r = renderStoragePath({ folder: '', name: '{{a}}' }, vars);
    expect(r).toMatchObject({ ok: true, name: '{a}.pdf' });
  });
  it('can never climb out: a value holding slashes or dots stays inside its segment', () => {
    const r = renderStoragePath({ folder: '{client}', name: 'f' }, { ...vars, client: '../../etc/passwd' });
    expect(r.ok && r.folder).toEqual(['-..-etc-passwd']);
    const dots = renderStoragePath({ folder: '{client}', name: 'f' }, { ...vars, client: '..' });
    expect(dots.ok && dots.folder).toEqual(['_']);
  });
  it('rejects a path that is too long', () => {
    const long = 'a'.repeat(100);
    expect(renderStoragePath({ folder: Array(5).fill(long).join('/'), name: long }, vars)).toMatchObject({
      ok: false,
    });
  });
});

describe('sanitizeStorageSegment', () => {
  it('replaces forbidden characters and trims dots and spaces', () => {
    expect(sanitizeStorageSegment('a:b*c?"d<e>f|g')).toBe('a-b-c-d-e-f-g');
    expect(sanitizeStorageSegment('  .name. ')).toBe('name');
  });
  it('suffixes Windows reserved names and fills empty ones', () => {
    expect(sanitizeStorageSegment('CON')).toBe('CON_');
    expect(sanitizeStorageSegment('nul.txt')).toBe('nul.txt_');
    expect(sanitizeStorageSegment('')).toBe('_');
  });
});

describe('templates and clashes', () => {
  it('checks a template without values', () => {
    expect(checkStorageTemplate('{journey}/{client}')).toEqual({ ok: true });
    expect(checkStorageTemplate('{bogus}')).toMatchObject({ ok: false });
    expect(checkStorageTemplate('{journey')).toMatchObject({ ok: false });
  });
  it('numbers a clashing name before the extension', () => {
    expect(storageClashName('a.pdf', 2)).toBe('a-2.pdf');
    expect(storageClashName('a', 3)).toBe('a-3');
  });
});

describe('errors and health', () => {
  it('marks retryable codes', () => {
    expect(storageError('unavailable', 'x').retryable).toBe(true);
    expect(storageError('auth_expired', 'x').retryable).toBe(false);
    expect(storageError('runner_offline', 'x').retryable).toBe(true);
  });
  it('maps an error to a health state', () => {
    expect(healthStateForError('auth_expired')).toBe('needs_reauth');
    expect(healthStateForError('quota')).toBe('quota');
    expect(healthStateForError('timeout')).toBe('unavailable');
  });
});

describe('protocol', () => {
  const id = '0b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11';
  it('accepts the write frames in both directions', () => {
    const open = makeEnvelope('storage.write.open', {
      transferId: id,
      connectionId: id,
      folder: 'a',
      name: 'b',
      vars: {},
      contentType: 'text/plain',
      size: 1,
      deadlineMs: 1000,
    });
    expect(ServerToRunnerSchema.safeParse(open).success).toBe(true);
    const chunk = makeEnvelope('storage.write.chunk', {
      transferId: id,
      seq: 0,
      data: Buffer.from('hi').toString('base64'),
    });
    expect(ServerToRunnerSchema.safeParse(chunk).success).toBe(true);
    const credit = makeEnvelope('storage.write.credit', { transferId: id, upTo: 8 });
    expect(RunnerToServerSchema.safeParse(credit).success).toBe(true);
    const result = makeEnvelope('storage.write.result', {
      transferId: id,
      ok: false,
      error: storageError('quota', 'full'),
    });
    expect(RunnerToServerSchema.safeParse(result).success).toBe(true);
  });
  it('acks reports and seals the connect command', () => {
    expect(isAckedFromRunner('storage.report')).toBe(true);
    expect(isAckedFromRunner('storage.auth')).toBe(true);
    expect(ENVELOPE_COMMANDS.has('storage.connect')).toBe(true);
  });
});
