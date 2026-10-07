import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanName, oneLiner, psq, renderBash, renderPowerShell, shq } from '../src/installer/render.ts';

const base = {
  serverUrl: 'https://hq.example.com',
  pairingCode: 'ABCD-EFGH',
  sessionToken: 'tok_0123456789abcdefghij',
  workstationName: 'Desk',
  release: { version: '1.2.3', sha256: 'f'.repeat(64) },
  generatedAt: new Date('2026-10-07T08:00:00Z'),
  expiresAt: new Date('2026-10-07T08:30:00Z'),
};
const win = {
  ...base,
  scriptUrl: 'https://hq.example.com/install/t/install.ps1',
  linuxScriptUrl: 'https://hq.example.com/install/t/install-linux-wsl.sh',
};

describe('quoting', () => {
  it('shq makes any text one literal bash word', () => {
    expect(shq('plain')).toBe("'plain'");
    expect(shq("it's")).toBe("'it'\\''s'");
    const nasty = [
      '$(touch /tmp/pwned)',
      '`id`',
      '"; rm -rf ~; "',
      "a'b'c",
      '\\',
      'x\ny',
      '${HOME}',
      '!history',
    ];
    for (const s of nasty) {
      const r = spawnSync('bash', ['-c', `printf %s ${shq(s)}`], { encoding: 'utf8' });
      expect(r.stdout, s).toBe(s);
    }
  });

  it('psq doubles the quote and nothing else is special', () => {
    expect(psq("O'Brien")).toBe("'O''Brien'");
    expect(psq('$env:USERPROFILE `n "x"')).toBe('\'$env:USERPROFILE `n "x"\'');
  });

  it('cleanName drops control characters and caps the length', () => {
    expect(cleanName('  a\u0000b\nc\td  ')).toBe('a b c d');
    expect(cleanName('x'.repeat(200))).toHaveLength(80);
  });
});

describe('rendered scripts', () => {
  it('embed the server URL, one-time code, token and release, and nothing else', () => {
    const sh = renderBash('linux', base);
    expect(sh).toContain("SERVER_URL='https://hq.example.com'");
    expect(sh).toContain("PAIRING_CODE='ABCD-EFGH'");
    expect(sh).toContain("SESSION_TOKEN='tok_0123456789abcdefghij'");
    expect(sh).toContain("RELEASE_VERSION='1.2.3'");
    expect(sh).toContain(`RELEASE_SHA256='${'f'.repeat(64)}'`);
    expect(sh).toContain('expires 2026-10-07T08:30:00.000Z');
    expect(sh).not.toMatch(/aomr_|aom_session|set-cookie|ANTHROPIC_API_KEY=sk-/i);
  });

  it('escape a hostile workstation name in bash and PowerShell', () => {
    const name = 'Pieter\'s $(rm -rf ~) `id` "q"\nnext';
    const sh = renderBash('linux', { ...base, workstationName: name });
    expect(sh).toContain(`DEFAULT_NAME=${shq(cleanName(name))}`);
    expect(sh).toContain("DEFAULT_NAME='Pieter'\\''s $(rm -rf ~) `id` \"q\" next'");
    const ps = renderPowerShell({ ...win, workstationName: name });
    expect(ps).toContain("$DefaultName = 'Pieter''s $(rm -rf ~) `id` \"q\" next'");
  });

  it('a hostile server URL stays inside its quotes', () => {
    const sh = renderBash('macos', { ...base, serverUrl: "https://x.test/'; touch /tmp/p; '" });
    expect(sh).toContain("SERVER_URL='https://x.test/'\\''; touch /tmp/p; '\\'''");
    const r = spawnSync(
      'bash',
      [
        '-c',
        `${sh
          .split('\n')
          .filter((l) => l.startsWith('SERVER_URL='))
          .join('\n')}\nprintf %s "$SERVER_URL"`,
      ],
      {
        encoding: 'utf8',
      },
    );
    expect(r.stdout).toBe("https://x.test/'; touch /tmp/p; '");
  });

  it('the Windows script is ASCII with CRLF line endings and carries the links', () => {
    const ps = renderPowerShell(win);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for non-ASCII bytes
    expect(ps).not.toMatch(/[^\u0000-\u007f]/);
    expect(ps.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r'))).toBe(true);
    expect(ps).toContain("$ScriptUrl = 'https://hq.example.com/install/t/install.ps1'");
    expect(ps).toContain("$LinuxScriptUrl = 'https://hq.example.com/install/t/install-linux-wsl.sh'");
    expect(ps).toContain('vmIdleTimeout=-1');
    expect(ps).toContain('systemd=true');
    expect(ps).toContain("'WSL Boot'");
    expect(ps).toContain('RunOnce');
  });

  it('one-line commands quote the URL', () => {
    expect(oneLiner('linux', 'https://a/b')).toBe("curl -fsSL 'https://a/b' | bash");
    expect(oneLiner('macos', 'https://a/b')).toBe("curl -fsSL 'https://a/b' | bash");
    expect(oneLiner('windows', 'https://a/b')).toBe("irm 'https://a/b' | iex");
  });
});

describe('script quality', () => {
  const dir = mkdtempSync(join(tmpdir(), 'installers-'));
  const files = { linux: renderBash('linux', base), macos: renderBash('macos', base) };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, `${name}.sh`), text);
  const have = (cmd: string) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;

  it.each(['linux', 'macos'])('%s installer is valid bash', (name) => {
    const r = spawnSync('bash', ['-n', join(dir, `${name}.sh`)], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it.skipIf(!have('shellcheck'))('the installers pass shellcheck', () => {
    const r = spawnSync('shellcheck', ['-x', '-s', 'bash', join(dir, 'linux.sh'), join(dir, 'macos.sh')], {
      encoding: 'utf8',
    });
    expect(r.stdout).toBe('');
    expect(r.status).toBe(0);
  });

  it('every installer ends by calling main as its last line (safe for curl | bash)', () => {
    for (const text of Object.values(files)) expect(text.trimEnd().split('\n').pop()).toBe('main "$@"');
  });

  it('cleans up', () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
