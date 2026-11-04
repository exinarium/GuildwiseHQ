import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const html = readFileSync(join(root, 'form.html'), 'utf8');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe('the public form page document', () => {
  it('has exactly one local module script, no inline script, no inline style and no third-party resource', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[1]).toMatch(/type="module"/);
    expect(scripts[0]?.[1]).toMatch(/src="\/src\/public-form\/main\.tsx"/);
    expect(scripts[0]?.[2]?.trim()).toBe('');
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/(src|href)="https?:\/\//i);
    expect(html).not.toContain('manifest');
    expect(html).toContain('name="robots" content="noindex,nofollow"');
    expect(html).toContain('name="referrer" content="no-referrer"');
  });

  it('the public page sources import nothing from the app shell, the extension, the socket or the router', () => {
    const files = walk(join(root, 'src', 'public-form')).filter((f) => /\.(ts|tsx)$/.test(f));
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string);
      for (const i of imports) {
        expect(i, f).not.toMatch(/extension|\/app\b|App\.tsx|ws\/|api\/client|react-router|lib\/activeOrg/);
      }
      expect(src, f).not.toContain('dangerouslySetInnerHTML');
      expect(src, f).not.toContain('localStorage');
    }
  });
});
