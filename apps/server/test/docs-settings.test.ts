import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseUnreleased } from '../src/blog/releases.ts';

/**
 * R29 (security hardening, 1.10.0): the README, the install guide (docs/SELF-HOSTING.md), the CHANGELOG, What's New and
 * the reinstall announcement must tell self-hosters what 1.10.0 changes. These checks read the files themselves, so a
 * later edit that drops a setting, its default, the Cloud lock or the reinstall steps fails here.
 */
const root = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

/** The text of one `## `/`### ` section (heading included) up to the next heading of the same or a higher level. */
function section(md: string, heading: RegExp): string {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{2,3}\s/.test(l) && heading.test(l));
  if (start < 0) return '';
  const level = (/^#+/.exec(lines[start] as string)?.[0] ?? '##').length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i] as string);
    if (m && (m[1] as string).length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

const SETTINGS = [
  { name: 'Only signed runners', env: 'AOM_REQUIRE_SIGNED_RUNNERS' },
  { name: 'Require two-factor login', env: 'AOM_ENFORCE_TWO_FACTOR' },
];

describe('README: security settings (R29)', () => {
  const readme = read('README.md');
  const part = section(readme, /security settings/i);

  it('has a Security settings section naming both settings, their env defaults and that both are off', () => {
    expect(part, 'README has no "Security settings" section').not.toBe('');
    for (const s of SETTINGS) {
      expect(part).toContain(s.name);
      expect(part).toContain(`${s.env}=false`);
    }
    expect(part).toMatch(/off by default/i);
  });

  it('says Guildwise Cloud locks both on, and that upgrading with the defaults locks nobody out', () => {
    expect(part).toMatch(/Guildwise Cloud[^.]*locks? both/i);
    expect(part).toMatch(/cannot be (turned off|changed)/i);
    expect(part).toMatch(/nobody is locked out/i);
  });

  it('says how unsigned runners are reinstalled and points to the install guide', () => {
    expect(part).toMatch(/reinstall/i);
    expect(part).toContain('Add a workstation');
    expect(part).toContain('docs/SELF-HOSTING.md');
  });

  it('calls 1.10.0 a breaking change for self-hosted installs', () => {
    expect(readme).toMatch(/1\.10\.0[^\n]*breaking/i);
  });
});

describe('install guide (docs/SELF-HOSTING.md): settings, signing and reinstall (R29)', () => {
  const guide = read('docs/SELF-HOSTING.md');
  const settings = section(guide, /security settings/i);
  const signing = section(guide, /sign(ing)? (your|the) runners? with your own key/i);
  const reinstall = section(guide, /reinstall(ing)? (unsigned |a )?runners?/i);
  const upgrade = section(guide, /upgrading to 1\.10\.0/i);

  it('documents both settings with their keys, defaults and the Cloud lock', () => {
    expect(settings, 'no "Security settings" section').not.toBe('');
    for (const s of SETTINGS) {
      expect(settings).toContain(s.name);
      expect(settings).toContain(s.env);
    }
    expect(settings).toMatch(/\boff\b/i);
    expect(settings).toContain('Set by Guildwise Cloud; cannot be changed here');
    expect(settings).toContain('setting_locked');
  });

  it('gives the own-key signing steps: key, package with the public key, sign, server key, own-key build, then the setting', () => {
    expect(signing, 'no "Signing your runners with your own key" section').not.toBe('');
    expect(signing).toMatch(/optional/i);
    for (const step of [
      'minisign -G',
      'scripts/package-runner.sh --pubkey',
      'minisign -S',
      'AOM_RUNNER_RELEASE_PUBKEY',
      'RUNNER_RELEASE=own-key',
      'Only signed runners',
    ])
      expect(signing).toContain(step);
    // the secret key never goes to the server or into an image
    expect(signing).toMatch(/never (copy|put)[^.]*secret key|secret key[^.]*never/i);
  });

  it('explains the reinstall from the server installer, the quarantine and that nothing is re-paired in place', () => {
    expect(reinstall, 'no reinstall section').not.toBe('');
    expect(reinstall).toContain('Add a workstation');
    expect(reinstall).toContain('Reinstall required');
    expect(reinstall).toMatch(/quarantin/i);
    expect(reinstall).toMatch(/signed_runner_required/);
    expect(reinstall).toMatch(/auto-?update/i);
  });

  it('has an "Upgrading to 1.10.0" section with what changes and the new keys', () => {
    expect(upgrade, 'no "Upgrading to 1.10.0" section').not.toBe('');
    expect(upgrade).toMatch(/breaking/i);
    expect(upgrade).toMatch(/nobody is locked out/i);
    for (const key of [
      'AOM_TWO_FACTOR_KEY',
      'AOM_REQUIRE_SIGNED_RUNNERS',
      'AOM_ENFORCE_TWO_FACTOR',
      'two-factor-reseal',
    ])
      expect(upgrade).toContain(key);
  });
});

describe('CHANGELOG and What’s New for 1.10.0 (R29)', () => {
  const changelog = read('CHANGELOG.md');

  it('[Unreleased] marks the self-hosted breaking changes (BREAKING entries under Changed) with the exact changes', () => {
    const unreleased = section(changelog, /^## \[Unreleased\]/i);
    // The intro says it, and the entries sit under a heading the release scanners know (an unknown heading would be read
    // as intro text on the public release page).
    expect(unreleased).toMatch(/Breaking for self-hosted installs/);
    const changed = section(unreleased, /^### Changed$/);
    const breaking = changed
      .split(/\n(?=- )/)
      .filter((e) => e.startsWith('- **BREAKING (self-hosted)'))
      .join('\n');
    expect(breaking, 'no BREAKING (self-hosted) entries under Changed').not.toBe('');
    for (const item of [
      'Only signed runners',
      'Require two-factor login',
      'AOM_TWO_FACTOR_KEY',
      '/api/admin/workstations',
      'AOM_VIDEO_PUSH_URL',
      'AOM_PLATFORM_TEAM_ORG_ID',
      'guildwise-runner setup',
      'nobody enrols again',
    ])
      expect(breaking).toContain(item);
    expect(breaking).toMatch(/to opt in/i);
    const parsed = parseUnreleased(changelog);
    expect(parsed?.breaking ?? 0).toBeGreaterThanOrEqual(5);
    // nothing of the entries leaks into the intro the release page shows
    expect(parsed?.intro).not.toContain('runners keep working');
  });

  it('has the runner-reinstall and self-hosted-upgrade What’s New entries pinned to 1.10.0', () => {
    const dir = new URL('apps/web/src/whats-new/entries/', root);
    const files = readdirSync(dir);
    for (const id of ['runner-reinstall', 'self-hosted-upgrade']) {
      const file = files.find((f) => f.endsWith(`-${id}.md`));
      expect(file, `no What's New entry *-${id}.md`).toBeDefined();
      const text = readFileSync(new URL(file as string, dir), 'utf8');
      expect(text).toMatch(/^release: 1\.10\.0$/m);
    }
  });

  it('has the reinstall announcement', () => {
    const path = 'docs/announcements/1.10.0-runner-reinstall.md';
    expect(existsSync(new URL(path, root))).toBe(true);
    const text = read(path);
    expect(text).toContain('Add a workstation');
    expect(text).toMatch(/quarantin/i);
    expect(text).toMatch(/change (your|this user's|the) (computer )?password/i);
  });
});
