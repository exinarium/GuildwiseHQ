import { describe, expect, it } from 'vitest';
import {
  CreateDocumentRequestSchema,
  DocumentDtoSchema,
  documentFileVaultPath,
  ListDocumentsQuerySchema,
  normalizeDocumentTag,
  normalizeDocumentTags,
  parseDocumentTagList,
  renderDocumentFile,
  VaultWriteFileCommandSchema,
} from '../src/index.ts';

const base = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Launch "plan"',
  kind: 'brief' as const,
  version: 2,
  status: 'approved' as const,
  content: 'Hello\n\n',
};

describe('renderDocumentFile', () => {
  it('writes exactly the pre-tags output when there are no tags and no file', () => {
    expect(
      renderDocumentFile({ ...base, approvedAt: '2026-01-01T00:00:00.000Z', sourceThreadIds: ['a', 'b'] }),
    ).toBe(
      [
        '---',
        'title: "Launch \\"plan\\""',
        'kind: brief',
        'status: approved',
        'version: 2',
        'document_id: 11111111-1111-4111-8111-111111111111',
        'approved_at: 2026-01-01T00:00:00.000Z',
        'sessions: [a, b]',
        '---',
        'Hello',
        '',
      ].join('\n'),
    );
    expect(renderDocumentFile({ ...base, tags: [] })).toBe(renderDocumentFile(base));
  });

  it('adds tags and the file lines only when present', () => {
    const out = renderDocumentFile({
      ...base,
      tags: ['a', 'b c'],
      file: { path: 'files/x.pdf', name: 'My "x".pdf' },
    });
    expect(out).toContain('tags: ["a", "b c"]\n');
    expect(out).toContain('file: "files/x.pdf"\n');
    expect(out).toContain('file_name: "My \\"x\\".pdf"\n');
  });
});

describe('tags', () => {
  it('normalizes a tag', () => {
    expect(normalizeDocumentTag('  Release Notes! ')).toBe('release-notes');
    expect(normalizeDocumentTag('Über_1.0')).toBe('über_1.0');
    expect(normalizeDocumentTag('###')).toBe('');
    expect(normalizeDocumentTag('x'.repeat(100))).toHaveLength(40);
  });
  it('drops empty and duplicate tags, keeping the first order', () => {
    expect(normalizeDocumentTags(['B', 'a', 'b', '', '!!', 'A'])).toEqual(['b', 'a']);
  });
  it('parses a comma list', () => {
    expect(parseDocumentTagList('Foo, bar ,,foo')).toEqual(['foo', 'bar']);
    expect(parseDocumentTagList(undefined)).toEqual([]);
  });
});

describe('document schemas', () => {
  it('lists with no new parameters as before, and accepts q and tags', () => {
    expect(ListDocumentsQuerySchema.parse({})).toEqual({});
    expect(ListDocumentsQuerySchema.parse({ q: '  plan ', tags: 'a,b' })).toEqual({ q: 'plan', tags: 'a,b' });
  });
  it('creates with no tags as before', () => {
    const r = CreateDocumentRequestSchema.parse({ kind: 'brief', title: 'x' });
    expect(r.tags).toBeUndefined();
    expect(() =>
      CreateDocumentRequestSchema.parse({ kind: 'brief', title: 'x', tags: Array(21).fill('a') }),
    ).toThrow();
  });
  it('accepts the file kind and keeps tags and file optional on the DTO', () => {
    const dto = {
      id: base.id,
      orgId: base.id,
      projectId: null,
      kind: 'file',
      title: 't',
      slug: 't',
      status: 'draft',
      currentVersion: 1,
      approvedVersion: null,
      sourceThreadIds: [],
      publishState: 'none',
      publishedVersion: null,
      vaultPath: null,
      createdBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(Object.keys(DocumentDtoSchema.parse(dto))).not.toContain('tags');
    expect(DocumentDtoSchema.parse({ ...dto, tags: ['a'] }).tags).toEqual(['a']);
  });
});

describe('vault.write_file', () => {
  it('validates the command and places the original under docs/files', () => {
    const ok = VaultWriteFileCommandSchema.parse({
      vaultId: 'v1',
      path: documentFileVaultPath('plan', 'pdf', 'projects/abc'),
      documentId: base.id,
      sha256: 'a'.repeat(64),
      size: 10,
      commitMessage: 'docs: file plan',
    });
    expect(ok.path).toBe('projects/abc/docs/files/plan.pdf');
    expect(ok.push).toBe(true);
    expect(documentFileVaultPath('plan', 'pdf')).toBe('org/docs/files/plan.pdf');
    expect(() => VaultWriteFileCommandSchema.parse({ ...ok, sha256: 'xyz' })).toThrow();
    expect(() => VaultWriteFileCommandSchema.parse({ ...ok, size: 0 })).toThrow();
  });
});
