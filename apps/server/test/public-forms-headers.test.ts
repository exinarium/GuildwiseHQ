import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { usePublicFormsWorld } from './helpers/public-forms.ts';

// A built web app as the server finds it: the app page and the small public form page.
const dist = mkdtempSync(join(tmpdir(), 'pf-dist-'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
writeFileSync(
  join(dist, 'form.html'),
  '<!doctype html><html><head><meta name="robots" content="noindex,nofollow"><script type="module" crossorigin src="/assets/form-abc.js"></script><link rel="stylesheet" href="/assets/form-abc.css"></head><body><div id="root"></div></body></html>',
);
const pf = usePublicFormsWorld({ AOM_SERVE_WEB: 'true', AOM_WEB_DIST: dist });

describe('the public page as built (AC7)', () => {
  it('serves form.html with the strict policy, and only same-origin scripts and styles load', async () => {
    const { publicId } = await pf.published(pf.definition('Built page'));
    const page = await pf.get(`/f/${publicId}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('id="root"');
    const urls = [...page.text.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] as string);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u.startsWith('/') && !u.startsWith('//')).toBe(true);
    expect(page.text).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i); // no inline script
    const csp = String(page.headers['content-security-policy']);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("script-src 'self'");
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('an unknown address gets the same page with a 404, so the answer does not say whether a form exists', async () => {
    const { publicId } = await pf.published(pf.definition('Exists'));
    const known = await pf.get(`/f/${publicId}`);
    const unknown = await pf.get('/f/Zz9_-Zz9_-Zz9_-Zz9_-Zz');
    expect(unknown.status).toBe(404);
    expect(unknown.text).toBe(known.text);
    expect(unknown.headers['content-security-policy']).toBe(known.headers['content-security-policy']);
  });

  it('the single-page app fallback does not take over /f/ addresses', async () => {
    const r = await pf.get('/f/not-a-form-id');
    expect(r.status).toBe(404);
    expect(String(r.headers['content-security-policy'])).toContain("default-src 'none'");
  });
});
