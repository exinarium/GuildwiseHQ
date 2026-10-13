import { describe, expect, it } from 'vitest';
import {
  checkAttachment,
  MAX_ATTACHMENT_BYTES,
  renderCardAttachments,
  safeAttachmentName,
} from '../src/index.ts';

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);

describe('checkAttachment', () => {
  it('accepts an image whose content matches its type, and serves it with the type of the extension', () => {
    const r = checkAttachment('screen.PNG', PNG);
    expect(r.ok && r.kind.contentType).toBe('image/png');
    expect(r.ok && r.kind.image).toBe(true);
  });

  it('accepts SVG as an image and text as text/plain', () => {
    const svg = checkAttachment('SlideOutHistory.svg', text('<?xml version="1.0"?><svg xmlns="x"></svg>'));
    expect(svg.ok && svg.kind.contentType).toBe('image/svg+xml');
    const html = checkAttachment('page.html', text('<html><script>alert(1)</script></html>'));
    expect(html.ok && html.kind.contentType).toBe('text/plain; charset=utf-8');
    expect(html.ok && html.kind.image).toBe(false);
  });

  it('refuses content that is not what the extension says', () => {
    expect(checkAttachment('x.png', text('not a png at all')).ok).toBe(false);
    expect(checkAttachment('x.svg', text('<html></html>')).ok).toBe(false);
    expect(checkAttachment('x.txt', bytes(0x68, 0x00, 0x69)).ok).toBe(false);
    expect(checkAttachment('x.pdf', text('hello')).ok).toBe(false);
  });

  it('refuses programs and scripts by extension and by content', () => {
    expect(checkAttachment('setup.exe', bytes(0x4d, 0x5a, 1, 2)).ok).toBe(false);
    expect(checkAttachment('run.sh', text('#!/bin/sh\necho hi')).ok).toBe(false);
    expect(checkAttachment('notes.txt', bytes(0x7f, 0x45, 0x4c, 0x46, 1)).ok).toBe(false);
    expect(checkAttachment('notes.txt', text('#!/bin/sh\nrm -rf /')).ok).toBe(false);
    expect(checkAttachment('x.js', text('alert(1)')).ok).toBe(false);
  });

  it('refuses unknown types, empty files and files over the limit', () => {
    expect(checkAttachment('x.weird', text('hello')).ok).toBe(false);
    expect(checkAttachment('noextension', text('hello')).ok).toBe(false);
    expect(checkAttachment('x.txt', new Uint8Array(0)).ok).toBe(false);
    expect(checkAttachment('big.txt', new Uint8Array(MAX_ATTACHMENT_BYTES + 1).fill(97)).ok).toBe(false);
  });
});

describe('safeAttachmentName', () => {
  it('drops directories, control characters and leading dots', () => {
    expect(safeAttachmentName('../../etc/passwd')).toBe('passwd');
    expect(safeAttachmentName('C:\\Users\\me\\shot.png')).toBe('shot.png');
    expect(safeAttachmentName('.hidden')).toBe('hidden');
    expect(safeAttachmentName('a\u0000b<c>.txt')).toBe('a_b_c_.txt');
    expect(safeAttachmentName('')).toBe('attachment');
  });
  it('keeps the extension when it shortens a long name', () => {
    const n = safeAttachmentName(`${'a'.repeat(400)}.png`);
    expect(n.length).toBeLessThanOrEqual(200);
    expect(n.endsWith('.png')).toBe(true);
  });
});

describe('renderCardAttachments', () => {
  it('lists the files and says they are read-only copies', () => {
    const out = renderCardAttachments('/tmp/aom-1/card-attachments', [
      { name: 'a.svg', size: 2048, path: '/tmp/aom-1/card-attachments/a.svg' },
    ]);
    expect(out).toContain('/tmp/aom-1/card-attachments/a.svg');
    expect(out).toContain('read-only');
    expect(renderCardAttachments('/x', [])).toBe('');
  });
});
