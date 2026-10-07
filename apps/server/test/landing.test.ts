import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { landingFor } from '../src/app.ts';

describe('which page serves /', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aom-web-'));
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  const bare = mkdtempSync(join(tmpdir(), 'aom-web-'));
  writeFileSync(join(bare, 'index.html'), '<html></html>');
  writeFileSync(join(dir, 'landing.html'), '<html></html>');

  it('hands the landing page to a visitor with no session cookie', () => {
    expect(landingFor({}, dir)).toBe('landing.html');
  });
  it('hands the app to anyone who has a session cookie (it redirects to their workspace)', () => {
    expect(landingFor({ aom_sid: 'abc' }, dir)).toBe('index.html');
  });
  it('falls back to the app when the build has no landing page', () => {
    expect(landingFor({}, bare)).toBe('index.html');
  });
});
