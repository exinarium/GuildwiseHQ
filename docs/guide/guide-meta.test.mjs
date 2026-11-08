import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGuideArgs, longDate, footerTemplate, GuideArgError, DEFAULT_GUIDE_DATE } from './guide-meta.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('no flags gives the default date, 7 October 2026', () => {
  const m = parseGuideArgs([]);
  assert.equal(m.date, DEFAULT_GUIDE_DATE);
  assert.equal(m.dateText, '7 October 2026');
  assert.equal(m.edition, null);
  assert.equal(m.given, false);
});

test('a valid ISO date is rendered in the long format', () => {
  const m = parseGuideArgs(['--date', '2026-11-08', '--edition', ' 1.6.0 ', '--out', 'x.pdf']);
  assert.equal(m.dateText, '8 November 2026');
  assert.equal(m.edition, '1.6.0');
  assert.equal(m.out, 'x.pdf');
  assert.equal(m.given, true);
  assert.equal(longDate('2024-02-29'), '29 February 2024');
});

test('bad dates throw an error naming the value', () => {
  for (const bad of ['not-a-date', '2026-13-40', '2026-02-30', '2026-1-5', '']) {
    assert.throws(() => parseGuideArgs(['--date', bad]), (e) => e instanceof GuideArgError && e.message.includes(`"${bad}"`));
  }
});

test('flags without a value are refused', () => {
  assert.throws(() => parseGuideArgs(['--date']), /--date needs a value/);
  assert.throws(() => parseGuideArgs(['--edition', '--out', 'a']), /--edition needs a value/);
});

test('edition limits', () => {
  assert.throws(() => parseGuideArgs(['--edition', 'x'.repeat(41)]), GuideArgError);
  assert.throws(() => parseGuideArgs(['--edition', 'a\u0007b']), GuideArgError);
  assert.throws(() => parseGuideArgs(['--edition', '   ']), GuideArgError);
});

test('the footer carries the date text and no other date', () => {
  const f = footerTemplate('8 November 2026');
  assert.match(f, /User Guide &middot; 8 November 2026</);
  assert.doesNotMatch(f, /October/);
  assert.match(footerTemplate('7 October 2026'), /User Guide &middot; 7 October 2026</);
});

test('cover.html has no hard-coded date and has the placeholders', () => {
  const cover = readFileSync(path.join(here, 'parts/cover.html'), 'utf8');
  assert.doesNotMatch(cover, /\b\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/);
  for (const p of ['data-guide-date', 'data-guide-release', 'data-guide-edition']) assert.ok(cover.includes(p), p);
});

test('build-guide with a bad date exits non-zero, names the value and writes no PDF', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'guide-'));
  const out = path.join(dir, 'x.pdf');
  const r = spawnSync(process.execPath, [path.join(here, 'build-guide.mjs'), '--out', out, '--date', 'not-a-date'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not-a-date/);
  assert.equal(existsSync(out), false);
});
